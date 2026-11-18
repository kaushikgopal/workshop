import assert from "node:assert/strict";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { ConversationView } from "@earendil-works/pi-durable";
import { test } from "node:test";
import { initialChatProjectorState, projectChatEvents } from "../service/project-chat-events.ts";

function view(live: JsonObject): Pick<ConversationView, "entries" | "docs"> {
  return { entries: [], docs: { "pi.live": live } };
}

test("projector sends text and tools already present when it attaches", () => {
  const projection = projectChatEvents(initialChatProjectorState(), {
    view: view({
      run: { taskId: "turn-1", inputs: ["submission-1"] },
      generation: { attempt: 1, message: { content: [{ type: "text", text: "Text already generated" }] } },
      tools: [{ callId: "tool-1", name: "search", status: "pending" }],
    }),
    chatRequestId: "chat-1",
  });

  assert.deepEqual(projection.events.map(({ type, chat_request_id, text, call_id }) => ({ type, chat_request_id, text, call_id })), [
    { type: "assistant.delta", chat_request_id: "chat-1", text: "Text already generated", call_id: undefined },
    { type: "tool.call", chat_request_id: "chat-1", text: undefined, call_id: "tool-1" },
  ]);
});

test("projector retains unsent events until durable correlation arrives", () => {
  const observation = view({
    run: { taskId: "turn-1", inputs: ["submission-1"] },
    generation: { attempt: 1, message: { content: [{ type: "text", text: "Already generated" }] } },
    tools: [{ callId: "tool-1", name: "search", status: "pending" }],
  });
  const unattached = projectChatEvents(initialChatProjectorState(), { view: observation });
  assert.deepEqual(unattached.events, []);

  const correlated = projectChatEvents(unattached.state, { view: observation, chatRequestId: "chat-recovered" });
  assert.deepEqual(correlated.events.map(({ type, chat_request_id, text, call_id }) => ({ type, chat_request_id, text, call_id })), [
    { type: "assistant.delta", chat_request_id: "chat-recovered", text: "Already generated", call_id: undefined },
    { type: "tool.call", chat_request_id: "chat-recovered", text: undefined, call_id: "tool-1" },
  ]);
});

test("projector emits nested tool completion when a later observation adds its summary", () => {
  const initial = projectChatEvents(initialChatProjectorState(), {
    view: view({
      run: { taskId: "turn-1", inputs: ["submission-1"] },
      generation: { attempt: 1, message: { content: [] } },
      nestedTools: [{ callId: "nested-1", name: "consult", arguments: { question: "Review" } }],
    }),
    chatRequestId: "chat-1",
  });
  assert.deepEqual(initial.events.map(({ type }) => type), ["tool.call"]);

  const completed = projectChatEvents(initial.state, {
    view: view({
      run: { taskId: "turn-1", inputs: ["submission-1"] },
      generation: { attempt: 1, message: { content: [] } },
      nestedTools: [{ callId: "nested-1", name: "consult", arguments: { question: "Review" }, summary: { isError: true } }],
    }),
    chatRequestId: "chat-1",
  });
  assert.deepEqual(completed.events.map(({ type, status, nested }) => ({ type, status, nested })), [
    { type: "tool.result", status: "error", nested: undefined },
  ]);
});

test("projector keeps one submission turn across generation tasks and ends it once settled", () => {
  const first = projectChatEvents(initialChatProjectorState(), {
    view: view({
      run: { taskId: "generation-1", inputs: ["submission-1"] },
      generation: { attempt: 1, message: { content: [{ type: "text", text: "first" }] } },
    }),
    chatRequestId: "chat-first",
  });
  const handoff = projectChatEvents(first.state, {
    view: view({
      run: { taskId: "generation-2", inputs: ["submission-1"] },
      generation: { attempt: 2, message: { content: [{ type: "text", text: "second" }] } },
    }),
    chatRequestId: "chat-first",
  });
  assert.deepEqual(handoff.events.map(({ type, chat_request_id }) => ({ type, chat_request_id })), [
    { type: "assistant.delta", chat_request_id: "chat-first" },
  ]);

  const stale = projectChatEvents(handoff.state, {
    view: view({
      run: { taskId: "generation-2", inputs: ["submission-1"] },
      generation: { attempt: 1, message: { content: [{ type: "text", text: "stale" }] } },
    }),
    chatRequestId: "chat-first",
  });
  assert.deepEqual(stale.events, []);
  assert.deepEqual(stale.state, handoff.state);

  const settled = projectChatEvents(handoff.state, {
    view: view({
      run: { taskId: "generation-2", inputs: ["submission-1"] },
      generation: { attempt: 2, message: { content: [{ type: "text", text: "second" }] } },
    }),
    chatRequestId: "chat-first",
    settledSubmissions: [{ submissionId: "submission-1", status: "done" }],
  });
  assert.deepEqual(settled.events.map(({ type, chat_request_id, status }) => ({ type, chat_request_id, status })), [
    { type: "run.end", chat_request_id: "chat-first", status: "done" },
  ]);
  const repeated = projectChatEvents(settled.state, {
    view: view({
      run: { taskId: "generation-2", inputs: ["submission-1"] },
      generation: { attempt: 2, message: { content: [{ type: "text", text: "second" }] } },
    }),
    chatRequestId: "chat-first",
    settledSubmissions: [{ submissionId: "submission-1", status: "done" }],
  });
  assert.deepEqual(repeated.events, []);
  assert.deepEqual(repeated.state, settled.state);
});

test("projector keeps text replacement pending through an empty retry observation", () => {
  const first = projectChatEvents(initialChatProjectorState(), {
    view: view({
      run: { taskId: "turn-1", inputs: ["submission-1"] },
      generation: { attempt: 1, message: { content: [{ type: "text", text: "Old partial" }] } },
    }),
    chatRequestId: "chat-1",
  });
  const retryWaiting = projectChatEvents(first.state, {
    view: view({
      run: { taskId: "turn-1", inputs: ["submission-1"] },
      generation: { attempt: 1, retry: { at: 1, error: "The provider is overloaded" } },
    }),
    chatRequestId: "chat-1",
  });
  assert.deepEqual(retryWaiting.events, []);
  const emptyRetry = projectChatEvents(retryWaiting.state, {
    view: view({
      run: { taskId: "turn-1", inputs: ["submission-1"] },
      generation: { attempt: 2, message: { content: [] } },
    }),
    chatRequestId: "chat-1",
  });
  assert.deepEqual(emptyRetry.events, []);

  const answer = projectChatEvents(emptyRetry.state, {
    view: view({
      run: { taskId: "turn-1", inputs: ["submission-1"] },
      generation: { attempt: 2, message: { content: [{ type: "text", text: "Replacement" }] } },
    }),
    chatRequestId: "chat-1",
  });
  assert.deepEqual(answer.events.map(({ type, text, replace }) => ({ type, text, replace })), [
    { type: "assistant.delta", text: "Replacement", replace: true },
  ]);
});

for (const firstAttempt of [1, 2]) {
  test(`projector replaces text after a folded task handoff with attempts ${firstAttempt} to 1`, () => {
    const first = projectChatEvents(initialChatProjectorState(), {
      view: view({
        run: { taskId: 10, inputs: ["submission-1"] },
        generation: { attempt: firstAttempt, message: { content: [{ type: "text", text: "Plan" }] } },
      }),
      chatRequestId: "chat-1",
    });
    const next = {
      run: { taskId: 11, inputs: ["submission-1"] },
      generation: { attempt: 1, message: { content: [{ type: "text", text: "Plan complete" }] } },
    };
    const handoff = projectChatEvents(first.state, { view: view(next) });
    assert.deepEqual(handoff.events, [
      { ok: true, type: "assistant.delta", chat_request_id: "chat-1", text: "Plan complete", replace: true },
    ]);
    const progress = projectChatEvents(handoff.state, {
      view: view({ ...next, generation: { attempt: 1, message: { content: [{ type: "text", text: "Plan complete." }] } } }),
    });
    assert.deepEqual(progress.events, [
      { ok: true, type: "assistant.delta", chat_request_id: "chat-1", text: "." },
    ]);
  });
}
