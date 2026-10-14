import { BoxRenderable, InputRenderable, ScrollBoxRenderable, TextRenderable, createCliRenderer, type CliRenderer } from "@opentui/core";
import type { BotPendingDecisionV1 } from "../bot/schema.js";
import type { ChatSource } from "./data-source.js";

const MAX_REFRESH_MS = 1_000;

export async function openChat(source: ChatSource): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" });
  const header = new TextRenderable(renderer, { height: 1, content: "WORKSHOP CHAT" });
  const transcript = new ScrollBoxRenderable(renderer, { flexGrow: 1, width: "100%", scrollX: false, stickyScroll: true, stickyStart: "bottom" });
  const messages = new TextRenderable(renderer, { content: "" });
  transcript.add(messages);
  const pending = new TextRenderable(renderer, { height: 6, content: "Pending decisions: none" });
  const input = new InputRenderable(renderer, { width: "100%" });
  const footer = new TextRenderable(renderer, { height: 1, content: "Enter sends · Tab selects · /continue or /reject answers a wait · /resolve handles a block · Esc quits" });
  root.add(header);
  root.add(transcript);
  root.add(pending);
  root.add(input);
  root.add(footer);
  renderer.root.add(root);
  input.focus();

  let current: Awaited<ReturnType<ChatSource["view"]>> | undefined;
  let selected = 0;
  let error: string | null = null;
  let refreshing = false;
  let refreshAgain = false;
  let stopped = false;
  const paint = (): void => {
    const entries = current?.entries ?? [];
    messages.content = entries.map(entry => {
      const name = entry.role === "user" ? "You" : entry.role === "assistant" ? "Bot" : "Activity";
      return name + ": " + entry.text;
    }).join("\n") || (current?.configured === false ? "Bot not configured" : "No messages yet");
    const decisions = current?.pending ?? [];
    selected = decisions.length === 0 ? 0 : Math.min(selected, decisions.length - 1);
    pending.content = [
      decisions.length === 0 ? "Pending decisions: none" : "Pending decisions (Tab selects):",
      ...decisions.map((decision, index) => formatDecision(decision, index === selected)),
      ...(error === null ? [] : ["Error: " + error]),
    ].join("\n");
    header.content = current?.configured === false ? "WORKSHOP CHAT · BOT NOT CONFIGURED" : "WORKSHOP CHAT";
  };
  const refresh = async (): Promise<void> => {
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    do {
      refreshAgain = false;
      try {
        current = await source.view(undefined, 50);
        error = null;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      paint();
    } while (refreshAgain && !stopped);
    refreshing = false;
  };
  const send = async (): Promise<void> => {
    const text = input.value;
    if (text.trim().length === 0) return;
    try {
      const command = text.trim().split(/\s+/u, 1)[0];
      if (command === "/continue" || command === "/reject" || command === "/resolve") await decide(text);
      else await source.submit(text);
      input.value = "";
      error = null;
      await refresh();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      paint();
    }
  };
  const decide = async (text: string): Promise<void> => {
    const decision = current?.pending[selected];
    if (decision === undefined) throw new Error("select a pending decision first");
    const [command, ...rest] = text.trim().split(/\s+/);
    const value = text.trim().slice(command!.length).trim();
    if (decision.kind === "wait") {
      if (command !== "/continue" && command !== "/reject") throw new Error("use /continue ANSWER or /reject ANSWER for this wait");
      if (value.length === 0) throw new Error("enter answer text after the wait action");
      await source.reply({ ...decision, action: command === "/continue" ? "continue" : "reject", answer: value });
      return;
    }
    if (command !== "/resolve" || rest.length === 0) throw new Error("use /resolve retry|fail REASON or /resolve accept FILE --acknowledge-effects");
    const action = rest[0];
    if (action !== "retry" && action !== "accept" && action !== "fail") throw new Error("block action must be retry, accept, or fail");
    if (!decision.actions.includes(action)) throw new Error("that action is not allowed for this block");
    if (action === "accept") {
      const match = value.match(/^accept\s+(\S+)\s+--acknowledge-effects$/);
      if (match === null) throw new Error("accept needs FILE and --acknowledge-effects");
      await source.resolve({ ...decision, action, resultFile: match[1]!, reason: "Human accepted the saved result in workshop chat." });
      return;
    }
    const reason = value.slice(action.length).trim();
    if (reason.length === 0) throw new Error("enter a reason after the block action");
    const needsRepeat = action === "retry" && (decision.blockKind === "external_outcome_unknown" || decision.blockKind === "process_death_unconfirmed");
    const repeatFlag = needsRepeat && reason.startsWith("--allow-repeat ");
    if (needsRepeat && !repeatFlag) throw new Error("retry needs --allow-repeat and a reason after checking outside effects");
    await source.resolve({ ...decision, action, reason: repeatFlag ? reason.slice("--allow-repeat ".length) : reason,
      ...(repeatFlag ? { allowRepeat: true } : {}) });
  };
  const timer = setInterval(() => void refresh(), MAX_REFRESH_MS);
  let shutdownDone = false;
  const shutdown = (): void => {
    if (shutdownDone) return;
    shutdownDone = true;
    stopped = true;
    clearInterval(timer);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    try { renderer.stop(); } catch { /* The renderer may already be stopping. */ }
    renderer.destroy();
  };
  renderer.keyInput.on("keypress", key => {
    if (key.name === "escape" || (key.name === "c" && key.ctrl)) { shutdown(); return; }
    if (key.name === "tab") {
      const count = current?.pending.length ?? 0;
      if (count > 0) { selected = (selected + 1) % count; paint(); }
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      transcript.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
      return;
    }
    if (key.name === "enter" || key.name === "return") void send();
  });
  renderer.on("resize", () => paint());
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  renderer.start();
  await refresh();
}

function formatDecision(decision: BotPendingDecisionV1, selected: boolean): string {
  const marker = selected ? "> " : "  ";
  if (decision.kind === "wait") return marker + decision.workflowId + " wait: " + decision.question + "\n    Proposal: " + decision.proposal;
  return marker + decision.workflowId + " block " + decision.blockKind + " (" + decision.actions.join(", ") + "): " + decision.reason;
}

