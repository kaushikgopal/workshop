import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { buildFailureFeedback, hashFailureEvidence } from "../src/attempt/build-failure-feedback.js";
import { checkDefinitionText } from "../src/definition/check-definition.js";
import { resolveWorkflowSettings } from "../src/definition/resolve-workflow-settings.js";
import { loadInstallation } from "../src/installation/load-installation.js";
import { projectServiceRead } from "../src/service/project-service-reads.js";
import { serviceMetadataV1Schema } from "../src/service/schema.js";
import { nodeDescriptionDtoSchema } from "../src/views/schema.js";
import { installationDocumentV1Schema } from "../src/installation/schema.js";
import { workflowRunDocumentV1Schema, workshopProcessV1Schema } from "../src/run/records.js";
import { prepareRunAdmission } from "../src/run/prepare-admission.js";
import { renderRunFiles } from "../src/run/render-run-files.js";
import { admitPreparedRun } from "../src/storage/durable/admit-run.js";
import { WorkshopInstallationDoc, WorkshopRunDoc } from "../src/storage/durable/define-workshop-records.js";
import { createWorkflowRunTaskInput, defineWorkshopTasks, parseWorkflowRunTaskInput } from "../src/storage/durable/define-workshop-tasks.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const emit = (value: string) => "printf '%s' " + shellQuote(value);
const success = emit("<status>succeeded</status>\n<output>candidate</output>");
const verdict = (decision: string, reason = "check reason", corrections?: string) => emit("<decision>" + decision + "</decision>\n<reason>" + reason + "</reason>"
  + (corrections === undefined ? "" : "\n<corrections>" + corrections + "</corrections>"));
const agent = (command: string) => ({ agent: { instructions: "Use the evidence.", model: "fixture/model:low", harness: { command } } });
const yaml = (nodes: unknown[], retries: number | "unlimited" = 0, replay = "safe") => JSON.stringify({ version: 4, defaults: { retries, replay }, steps: nodes });

async function openFixture(directory: string, shell = "/bin/sh", beforeLaunch?: (conversationId: ConversationId, signal: AbortSignal) => Promise<void>) {
  const opened = await openDurableStorage(join(directory, "durable.db"));
  if (!opened.ok) throw new Error(opened.failure.message);
  const tasks = defineWorkshopTasks(undefined, beforeLaunch === undefined ? {} : { beforeLaunch });
  const registry = createRegistry();
  registry.install({ name: "decisions", tasks: [tasks.WorkflowRunTask, tasks.NodeAttemptTask, tasks.ProcessExecutionTask, tasks.CapacityGateTask] });
  const harness = await Harness.open(opened.storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
  return { harness, tasks, shell };
}

type Fixture = Awaited<ReturnType<typeof openFixture>>;
async function executeFixture(directory: string, source: string, check: (run: Extract<ReturnType<typeof workflowRunDocumentV1Schema.parse>, { state: "ready" }>, fixture: Fixture, conversationId: ConversationId) => Promise<void> | void, shell = "/bin/sh", beforeIdle?: (fixture: Fixture, conversationId: ConversationId) => Promise<Fixture | void>, beforeLaunch?: (conversationId: ConversationId, signal: AbortSignal) => Promise<void>) {
  let fixture: Fixture | undefined;
  try {
    fixture = await openFixture(directory, shell, beforeLaunch);
    const definition = checkDefinitionText(source, "decisions.yaml", "decisions").def;
    const machine = { shell };
    const resolvedSettings = resolveWorkflowSettings({ definition, machine, projectCwd: directory });
    const at = new Date().toISOString();
    const prepared = prepareRunAdmission({
      sourceText: source, sourceLabel: "decisions.yaml", workflowId: "decisions", machineConfig: machine, resolvedSettings,
      projectCwd: directory, stateDirectory: join(directory, "state"),
      runtimeManifest: { durableVersion: "1.0.2", integrationManifestHash: "sha256:" + createHash("sha256").update("decisions").digest("hex"),
        taskVersions: { workflowRun: 10, nodeAttempt: 4, processExecution: 4, capacityGate: 1 } },
      runId: "decisions-" + randomUUID(), eventId: randomUUID(), activationId: "activation", occurrenceId: "occurrence", requestId: randomUUID(), admittedAt: at,
    });
    if (!prepared.ok) throw new Error(prepared.failure.message);
    const installation = installationDocumentV1Schema.parse({ state: "ready", installationId: "decisions", maxConcurrentRuns: 1,
      workflows: { decisions: { definitionHash: prepared.value.canonicalHash, admissionHighWater: 0, openRunId: null,
        activations: [{ activationId: "activation", state: "active", admittedCount: 0, maxRuns: 1, activatedAt: at, nextDueAt: null }],
        occurrenceCounters: { activation: 0 }, runs: [], requestIndex: {}, capacityReservations: [], preflightCache: {} } } });
    await fixture.harness.commit(async (tx) => { Object.assign(await tx.doc(WorkshopInstallationDoc), installation); }, BACKGROUND_CONTEXT);
    const admission = await admitPreparedRun({ harness: fixture.harness, prepared: prepared.value, workflowRunTask: fixture.tasks.WorkflowRunTask,
      createTaskInput: createWorkflowRunTaskInput, parseTaskInput: parseWorkflowRunTaskInput, context: BACKGROUND_CONTEXT });
    if (!admission.ok) throw new Error(admission.failure.message);
    // SAFETY: admission returns the Durable conversation ID committed with this run.
    const conversationId = admission.value.conversationId as ConversationId;
    await fixture.harness.resume();
    const resumed = await beforeIdle?.(fixture, conversationId);
    if (resumed !== undefined) fixture = resumed;
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    const run = workflowRunDocumentV1Schema.parse(await fixture.harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT));
    if (run.state !== "ready") throw new Error("run disappeared");
    await check(run, fixture, conversationId);
    const workflowDirectory = join(directory, ".workshop", "workflows");
    mkdirSync(workflowDirectory, { recursive: true });
    writeFileSync(join(workflowDirectory, "decisions.yaml"), source);
    const metadata = serviceMetadataV1Schema.parse({ version: 1, status: "ready", pid: process.pid,
      startIdentity: "fixture", bootId: randomUUID(), startedAt: at, socketPath: join(directory, "unused.sock") });
    for (const node of run.nodes) {
      const projected = nodeDescriptionDtoSchema.parse(await projectServiceRead(fixture.harness, loadInstallation(directory), metadata,
        { version: 1, method: "node.describe", workflowId: "decisions", nodeId: node.nodeId, runId: run.runId }));
      expect(projected.node.status).toBe(node.status);
    }
  } finally {
    if (fixture !== undefined) await fixture.harness.close(BACKGROUND_CONTEXT);
  }
}

async function withDirectory(action: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "workshop-decisions-"));
  try { await action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("format 4 decision table", () => {
  for (const row of [
    { name: "valid worker without verifier", node: { run: "printf candidate" }, status: "completed" },
    { name: "command verifier accepts", node: { run: "printf candidate", verify: "test $(cat) = candidate" }, status: "completed" },
    { name: "agent verifier accepts even with no retries", node: { run: "printf candidate", verify: agent(verdict("accept")) }, status: "completed" },
    { name: "command rejection without permitted retry", node: { run: "printf candidate", verify: "exit 7" }, status: "failed" },
    { name: "agent rejection without permitted retry", node: { run: "printf candidate", verify: agent(verdict("retry")) }, status: "failed" },
    { name: "unsafe replay never permits retry", node: { run: "exit 9" }, status: "failed", replay: "never" },
    { name: "agent verifier blocks", node: { run: "printf candidate", verify: agent(verdict("block")) }, status: "blocked", block: "verifier_block" },
  ] as const) {
    test(row.name, async () => withDirectory(async (directory) => {
      await executeFixture(directory, yaml([{ first: row.node }, { later: "printf successor" }], 0, row.replay), (run) => {
        expect(run.status).toBe(row.status);
        expect(run.block?.kind).toBe(row.block);
        expect(run.nodes[1]?.attempts.length).toBe(row.status === "completed" ? 1 : 0);
      });
    }));
  }

  for (const verifierKind of ["none", "command", "agent"] as const) {
    test("worker failure retries with " + verifierKind + " verifier", async () => withDirectory(async (directory) => {
      const verifierMarker = join(directory, "verifier");
      const verifier = verifierKind === "none" ? {} : { verify: verifierKind === "command"
        ? "printf v >> " + shellQuote(verifierMarker)
        : agent("cat > " + shellQuote(verifierMarker) + "; if [ $WORKSHOP_ATTEMPT = 1 ]; then " + verdict("retry") + "; else " + verdict("accept") + "; fi") };
      await executeFixture(directory, yaml([{ first: { run: "if [ $WORKSHOP_ATTEMPT = 1 ]; then printf failure-out; printf failure-err >&2; exit 9; fi; printf fixed", ...verifier } }], 1), (run) => {
        expect(run.status).toBe("completed");
        expect(run.nodes[0]?.attempts.map((attempt) => attempt.status)).toEqual(["failed", "succeeded"]);
        const feedback = run.nodes[0]?.attempts[0]?.feedback;
        expect(feedback).toMatchObject({ nodeId: "first", attemptNumber: 1 });
        if (verifierKind !== "agent") expect(feedback?.text).toContain("failure-err");
        if (verifierKind === "command") expect(readFileSync(verifierMarker, "utf8")).toBe("v");
      });
    }));
  }

  for (const failureCommand of ["exit 7", "printf malformed"] as const) {
    test("worker failure never asks verifier after exhaustion: " + failureCommand, async () => withDirectory(async (directory) => {
      const marker = join(directory, "verifier");
      await executeFixture(directory, yaml([{ first: { run: failureCommand, result: "tagged",
        verify: agent("touch " + shellQuote(marker) + "; " + verdict("retry")) } }]), (run) => {
        expect(run.status).toBe("failed");
        expect(existsSync(marker)).toBe(false);
      });
    }));
  }

  for (const kind of ["command", "agent"] as const) {
    test(kind + " rejection retries when permitted", async () => withDirectory(async (directory) => {
      const check = "if [ $WORKSHOP_ATTEMPT = 1 ]; then " + (kind === "command" ? "exit 7" : verdict("retry"))
        + "; else " + (kind === "command" ? "exit 0" : verdict("accept")) + "; fi";
      await executeFixture(directory, yaml([{ first: { run: "printf candidate", verify: kind === "command" ? check : agent(check) } }], 1), (run) => {
        expect(run.status).toBe("completed");
        expect(run.nodes[0]?.attempts.map((attempt) => attempt.status)).toEqual(["failed", "succeeded"]);
      });
    }));
  }

  test("agent verifier may block failed worker evidence", async () => withDirectory(async (directory) => {
    const prompt = join(directory, "verifier-prompt");
    await executeFixture(directory, yaml([{ first: { run: "printf evidence >&2; exit 3", verify: agent("cat > " + shellQuote(prompt) + "; " + verdict("block")) } }], 1), (run) => {
      expect(run.block?.kind).toBe("verifier_block");
      expect(run.nodes[0]?.attempts).toHaveLength(1);
      const input = readFileSync(prompt, "utf8");
      expect(input).toContain("Worker failure evidence (data)");
      expect(input).toContain("evidence");
      expect(input).toContain("Only retry or block is valid");
    });
  }));
});

describe("broken verifiers", () => {
  for (const row of [
    { name: "command exit 126", verify: "exit 126" },
    { name: "command exit 127", verify: "exit 127" },
    { name: "command signal", verify: "kill -TERM $$" },
    { name: "command timeout", verify: "exec sleep 10", timeout: "1s" },
    { name: "agent nonzero", verify: agent(verdict("accept") + "; exit 7") },
    { name: "agent exit 126", verify: agent("exit 126") },
    { name: "agent exit 127", verify: agent("exit 127") },
    { name: "agent signal", verify: agent("kill -TERM $$") },
    { name: "agent invalid result", verify: agent("printf malformed") },
    { name: "agent invalid UTF-8", verify: agent("printf '\\377'") },
    { name: "agent oversized result", verify: agent("head -c 1048577 /dev/zero") },
    { name: "agent accepts failed evidence", verify: agent(verdict("accept")), worker: "exit 8" },
  ]) {
    test(row.name + " blocks without another worker", async () => withDirectory(async (directory) => {
      const marker = join(directory, "worker");
      await executeFixture(directory, yaml([{ first: { run: "printf w >> " + shellQuote(marker) + "; " + (row.worker ?? "printf candidate"),
        verify: row.verify, ...(row.timeout === undefined ? {} : { timeout: row.timeout }) } }], 2), (run) => {
        expect(run.block?.kind).toBe("verifier_failed");
        expect(run.nodes[0]?.attempts).toHaveLength(1);
        expect(readFileSync(marker, "utf8")).toBe("w");
      });
    }));
  }

  test("launch failure blocks instead of repeating the worker", async () => withDirectory(async (directory) => {
    const shell = join(directory, "shell");
    symlinkSync("/bin/sh", shell);
    await executeFixture(directory, yaml([{ first: { run: "rm " + shellQuote(shell) + "; printf candidate", verify: "exit 0" } }], 2), (run) => {
      expect(run.block?.kind).toBe("verifier_failed");
      expect(run.nodes[0]?.attempts).toHaveLength(1);
    }, shell);
  }));
});

describe("retry evidence", () => {
  for (const command of ["printf same-error >&2; exit 9", "printf malformed"] as const) {
    test("identical worker failures block unlimited retries: " + command, async () => withDirectory(async (directory) => {
      await executeFixture(directory, yaml([{ first: { run: command, result: "tagged" } }], "unlimited"), (run) => {
        expect(run.block?.kind).toBe("repeated_failure");
        expect(run.nodes[0]?.attempts).toHaveLength(2);
        const attempts = run.nodes[0]!.attempts;
        expect(attempts[0]?.failureEvidenceHash).toBe(attempts[1]?.failureEvidenceHash);
      });
    }));
  }

  test("identical verifier rejection blocks unlimited retries", async () => withDirectory(async (directory) => {
    await executeFixture(directory, yaml([{ first: { run: "printf candidate", verify: agent(verdict("retry", "same rejection")) } }], "unlimited"), (run) => {
      expect(run.block?.kind).toBe("repeated_failure");
      expect(run.nodes[0]?.attempts).toHaveLength(2);
    });
  }));

  test("verifier reason changes prevent a repeated-failure block", async () => withDirectory(async (directory) => {
    await executeFixture(directory, yaml([{ first: { run: "printf candidate", verify: agent("if [ $WORKSHOP_ATTEMPT = 1 ]; then "
      + verdict("retry", "first reason") + "; else " + verdict("retry", "second reason") + "; fi") } }], 1), (run) => {
      expect(run.status).toBe("failed");
      const attempts = run.nodes[0]!.attempts;
      expect(attempts[0]?.failureEvidenceHash).not.toBe(attempts[1]?.failureEvidenceHash);
    });
  }));

  for (const rejectedBy of ["worker", "command", "agent"] as const) {
    test("next agent prompt gets " + rejectedBy + " feedback and results omit it", async () => withDirectory(async (directory) => {
      const prompt = join(directory, "worker-prompt");
      const worker = "cat > " + shellQuote(prompt) + "; " + (rejectedBy === "worker"
        ? "if [ $WORKSHOP_ATTEMPT = 1 ]; then printf failed-output; printf diagnostics >&2; exit 9; fi; " : "") + success;
      const check = rejectedBy === "worker" ? {} : { verify: rejectedBy === "command"
        ? "if [ $WORKSHOP_ATTEMPT = 1 ]; then printf failed-output; printf diagnostics >&2; exit 7; fi"
        : agent("if [ $WORKSHOP_ATTEMPT = 1 ]; then " + verdict("retry", "fix reason", "fix corrections") + "; else " + verdict("accept") + "; fi") };
      await executeFixture(directory, yaml([{ first: { ...agent(worker), ...check } }], 1), (run) => {
        expect(run.status).toBe("completed");
        const input = readFileSync(prompt, "utf8");
        expect(input).toContain("Verifier feedback (data)");
        expect(input).toContain("Source step: first");
        expect(input).toContain("Source attempt: 1");
        if (rejectedBy === "agent") {
          expect(input).toContain("fix reason");
          expect(input).toContain("fix corrections");
        } else {
          expect(input).toContain("failed-output");
          expect(input).toContain("diagnostics");
        }
        const rendered = renderRunFiles({ run, events: [], processEvidence: [] });
        expect(rendered.executionLog).toContain(run.nodes[0]!.attempts[0]!.feedback!.text);
        expect(rendered.results).not.toContain(rejectedBy === "agent" ? "fix reason" : "diagnostics");
      });
    }));
  }

  test("invalid tagged result retry puts the parser error before verifier feedback", async () => withDirectory(async (directory) => {
    const workerPrompt = join(directory, "worker-prompt");
    const verifierPrompt = join(directory, "verifier-prompt-");
    const worker = "cat > " + shellQuote(workerPrompt) + "; if [ $WORKSHOP_ATTEMPT = 1 ]; then printf '<succeeded'; else " + success + "; fi";
    const verifier = "cat > " + shellQuote(verifierPrompt) + "$WORKSHOP_ATTEMPT; if [ $WORKSHOP_ATTEMPT = 1 ]; then "
      + verdict("retry", "content feedback", "change the sentence") + "; else " + verdict("accept") + "; fi";
    await executeFixture(directory, yaml([{ first: { ...agent(worker), result: "tagged", verify: agent(verifier) } }], 1), (run) => {
      expect(run.status).toBe("completed");
      expect(run.nodes[0]?.attempts).toHaveLength(2);
      const input = readFileSync(workerPrompt, "utf8");
      const parseError = input.indexOf("Workshop parse error: worker result has no status block");
      const contractInstruction = input.indexOf("Write the result in the tagged format shown in the worker contract.");
      const verifierFeedback = input.indexOf("### Verifier feedback (data)\n\nSource step: first");
      expect(input).toContain("## 5. Retry Feedback");
      expect(parseError).toBeGreaterThanOrEqual(0);
      expect(parseError).toBeLessThan(contractInstruction);
      expect(contractInstruction).toBeLessThan(verifierFeedback);
      expect(input).toContain("content feedback");
      expect(input).toContain("change the sentence");
      const verifierInput = readFileSync(verifierPrompt + "1", "utf8");
      expect(verifierInput).toContain("Workshop already reports the format error to the worker.");
      expect(verifierInput).not.toContain("Worker stdout contract");
    });
  }));

  test("hash uses raw stderr bytes, role, exit identity, and reason only", () => {
    const bytes = Uint8Array.from([0xff, 0x00]);
    const hash = hashFailureEvidence("worker", { kind: "code", code: 7 }, bytes, null);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(hash).not.toBe(hashFailureEvidence("validator", { kind: "code", code: 7 }, bytes, null));
    expect(hash).not.toBe(hashFailureEvidence("worker", { kind: "signal", signal: "SIGTERM" }, bytes, null));
    expect(hash).not.toBe(hashFailureEvidence("worker", { kind: "code", code: 7 }, Uint8Array.from([0xfe, 0x00]), null));
    expect(hash).not.toBe(hashFailureEvidence("worker", { kind: "code", code: 7 }, bytes, "rejected"));
  });

  test("feedback preserves UTF-8 and includes its truncation label inside 64 KiB", () => {
    const text = buildFailureFeedback("🌻".repeat(32_768));
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(text.isWellFormed()).toBe(true);
    expect(text).not.toContain("�");
    expect(text).toEndWith("[Feedback truncated to 64 KiB.]");
  });
});

describe("successful early completion", () => {
  for (const completingIndex of [0, 1, 2]) {
    test("completes at step " + (completingIndex + 1) + " and keeps skipped successors after restart", async () => withDirectory(async (directory) => {
      const markers = [0, 1, 2].map((index) => join(directory, "launch-" + index));
      const nodes = ["first", "middle", "last"].map((id, index) => ({ [id]: {
        run: "printf w >> " + shellQuote(markers[index]!) + "; " + emit("<status>" + (index === completingIndex ? "success_and_complete" : "succeeded")
          + "</status>\n<reason>accepted reason</reason>\n<output>output-" + index + "</output>"), result: "tagged", verify: "exit 0",
      } }));
      let savedConversationId: ConversationId | undefined;
      await executeFixture(directory, yaml(nodes), async (run, fixture, conversationId) => {
        savedConversationId = conversationId;
        const index = installationDocumentV1Schema.parse(await fixture.harness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT));
        if (index.state !== "ready") throw new Error("early completion index disappeared");
        expect(index.workflows.decisions?.openRunId).toBeNull();
        expect(index.workflows.decisions?.capacityReservations).toEqual([]);
        expect(run.status).toBe("completed");
        expect(run.terminalOutput).toBe("output-" + completingIndex);
        expect(run.nodes.map((node) => node.status)).toEqual([0, 1, 2].map((index) => index <= completingIndex ? "succeeded" : "skipped"));
        for (const [index, node] of run.nodes.entries()) expect(node.attempts).toHaveLength(index <= completingIndex ? 1 : 0);
        const text = renderRunFiles({ run, events: [], processEvidence: [] }).results;
        const tag = createHash("sha256").update(run.runId).digest("hex").slice(0, 8);
        for (const [index, node] of run.nodes.entries()) {
          if (index > completingIndex) expect(text).toContain("<skipped-" + node.nodeId + "-" + tag + " />");
        }
      });
      const reopened = await openFixture(directory);
      try {
        await reopened.harness.resume();
        await reopened.harness.waitForIdle(BACKGROUND_CONTEXT);
        if (savedConversationId === undefined) throw new Error("missing restart identity");
        const run = workflowRunDocumentV1Schema.parse(await reopened.harness.snapshot(WorkshopRunDoc, savedConversationId, BACKGROUND_CONTEXT));
        if (run.state !== "ready") throw new Error("restarted run disappeared");
        expect(run.status).toBe("completed");
        for (const [index, marker] of markers.entries()) expect(existsSync(marker)).toBe(index <= completingIndex);
        const conversation = await reopened.harness.conversation(savedConversationId, BACKGROUND_CONTEXT);
        if (conversation === undefined) throw new Error("restarted conversation disappeared");
        const processes = (await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT)).items
          .filter((entry) => entry.kind === "workshop.process").map((entry) => workshopProcessV1Schema.parse(entry.data));
        expect(processes.every((record) => record.nodeId === null || run.chain.order.indexOf(record.nodeId) <= completingIndex)).toBe(true);
      } finally { await reopened.harness.close(BACKGROUND_CONTEXT); }
    }));
  }

  test("early completion does not bypass a rejecting verifier", async () => withDirectory(async (directory) => {
    await executeFixture(directory, yaml([{ first: { run: emit("<status>success_and_complete</status>\n<output>done</output>"), result: "tagged", verify: "exit 7" } }, { later: "exit 0" }]), (run) => {
      expect(run.status).toBe("failed");
      expect(run.nodes[1]?.status).toBe("pending");
    });
  }));
});

test("command retry gets identical predecessor stdin, without feedback", async () => withDirectory(async (directory) => {
  const input = join(directory, "stdin-");
  await executeFixture(directory, yaml([{ before: "printf previous-output" }, { first: { run: "cat > " + shellQuote(input) + "$WORKSHOP_ATTEMPT; if [ $WORKSHOP_ATTEMPT = 1 ]; then printf error >&2; exit 7; fi; printf done" } }], 1), (run) => {
    expect(run.status).toBe("completed");
    expect(readFileSync(input + "1", "utf8")).toBe("previous-output");
    expect(readFileSync(input + "2", "utf8")).toBe("previous-output");
  });
}));

test("full-size agent reason and corrections produce bounded retry feedback", async () => withDirectory(async (directory) => {
  const script = join(directory, "verifier.js");
  writeFileSync(script, "process.stdout.write('<decision>retry</decision>\\n<reason>' + 'r'.repeat(65536) + '</reason>\\n<corrections>' + 'c'.repeat(65536) + '</corrections>')");
  await executeFixture(directory, yaml([{ first: { run: "printf candidate", verify: agent("bun " + shellQuote(script)) } }]), (run) => {
    expect(run.status).toBe("failed");
    const feedback = run.nodes[0]?.attempts[0]?.feedback?.text;
    expect(feedback).toBeDefined();
    expect(Buffer.byteLength(feedback ?? "", "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(feedback).toEndWith("[Feedback truncated to 64 KiB.]");
  });
}));

test("identical failure on the final permitted retry blocks before exhaustion", async () => withDirectory(async (directory) => {
  await executeFixture(directory, yaml([{ first: "printf same >&2; exit 7" }], 1), (run) => {
    expect(run.block?.kind).toBe("repeated_failure");
    expect(run.nodes[0]?.attempts).toHaveLength(2);
  });
}));

test("an aborted verifier without a checked retirement receipt keeps capacity reserved", async () => withDirectory(async (directory) => {
  const launched = join(directory, "verifier-launched");
  await executeFixture(directory, yaml([{ first: { run: "printf candidate", verify: "touch " + shellQuote(launched) + "; exec sleep 30" } }]), async (run, fixture) => {
    expect(run.block?.kind).toBe("process_death_unconfirmed");
    const index = installationDocumentV1Schema.parse(await fixture.harness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT));
    if (index.state !== "ready") throw new Error("blocked index disappeared");
    expect(index.workflows.decisions?.capacityReservations).toEqual([run.runId]);
  }, "/bin/sh", async (fixture, conversationId) => {
    const deadline = Date.now() + 5_000;
    while (!existsSync(launched) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(launched)).toBe(true);
    const conversation = await fixture.harness.conversation(conversationId, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error("verifier conversation disappeared");
    const record = (await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT)).items
      .filter((entry) => entry.kind === "workshop.process").map((entry) => workshopProcessV1Schema.parse(entry.data))
      .find((entry) => entry.process.role === "validator" && entry.process.status === "running");
    if (record === undefined) throw new Error("verifier launch evidence disappeared");
    // SAFETY: checked process evidence stores its Durable task ID.
    await fixture.harness.abortTask(record.taskId as TaskId, BACKGROUND_CONTEXT);
  });
}), 15_000);

test("restart after saved feedback reconstructs the next prompt without another first attempt", async () => withDirectory(async (directory) => {
  const prompt = join(directory, "worker-prompt");
  const launches = join(directory, "worker-launches");
  let active: Fixture | undefined;
  let retryReady = false;
  const gate = async (conversationId: ConversationId, signal: AbortSignal) => {
    if (active === undefined) return;
    const run = workflowRunDocumentV1Schema.parse(await active.harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT));
    if (run.state !== "ready" || run.nodes[0]?.attempts.at(-1)?.number !== 2) return;
    retryReady = true;
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  await executeFixture(directory, yaml([{ first: agent("printf w >> " + shellQuote(launches) + "; cat > " + shellQuote(prompt)
    + "; if [ $WORKSHOP_ATTEMPT = 1 ]; then printf saved-diagnostic >&2; exit 7; fi; " + success) }], 1), (run) => {
    expect(run.status).toBe("completed");
    expect(run.nodes[0]?.attempts).toHaveLength(2);
    expect(readFileSync(launches, "utf8")).toBe("ww");
    const input = readFileSync(prompt, "utf8");
    expect(input).toContain("Source step: first");
    expect(input).toContain("Source attempt: 1");
    expect(input).toContain("saved-diagnostic");
  }, "/bin/sh", async (fixture, conversationId) => {
    active = fixture;
    const deadline = Date.now() + 5_000;
    while (!retryReady && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(retryReady).toBe(true);
    const saved = workflowRunDocumentV1Schema.parse(await fixture.harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT));
    if (saved.state !== "ready") throw new Error("saved feedback run disappeared");
    expect(saved.nodes[0]?.attempts[0]?.feedback?.text).toContain("saved-diagnostic");
    expect(readFileSync(launches, "utf8")).toBe("w");
    await fixture.harness.close(BACKGROUND_CONTEXT);
    const reopened = await openFixture(directory);
    await reopened.harness.resume();
    return reopened;
  }, gate);
}), 15_000);
