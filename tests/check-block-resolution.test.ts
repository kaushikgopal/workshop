import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { checkDefinitionText } from "../src/definition/check-definition.js";
import { resolveWorkflowSettings } from "../src/definition/resolve-workflow-settings.js";
import { loadInstallation } from "../src/installation/load-installation.js";
import { installationDocumentV1Schema } from "../src/installation/schema.js";
import { checkBlockResolution } from "../src/run/check-block-resolution.js";
import { workflowRunDocumentV1Schema } from "../src/run/records.js";
import { prepareRunAdmission } from "../src/run/prepare-admission.js";
import { blockInfoSchema, operatorResolutionSchema, type BlockInfo } from "../src/run/schema.js";
import { resolveBlockedWorkflow } from "../src/service/open-service-runtime.js";
import { projectServiceRead } from "../src/service/project-service-reads.js";
import { nodeDescriptionDtoSchema } from "../src/views/schema.js";
import { serviceMetadataV1Schema } from "../src/service/schema.js";
import { parseServiceRequestLine } from "../src/service/parse-service-protocol.js";
import { serviceRequestV1Schema, type ServiceRequestV1 } from "../src/service/schema.js";
import { admitPreparedRun } from "../src/storage/durable/admit-run.js";
import { WorkshopInstallationDoc, WorkshopRunDoc } from "../src/storage/durable/define-workshop-records.js";
import { createWorkflowRunTaskInput, defineWorkshopTasks, parseWorkflowRunTaskInput } from "../src/storage/durable/define-workshop-tasks.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";

type ReadyRun = Extract<ReturnType<typeof workflowRunDocumentV1Schema.parse>, { state: "ready" }>;
type ResolveRequest = Extract<ServiceRequestV1, { method: "resolve" }>;
const rows = [
  { kind: "verifier_block", actions: ["retry", "fail"], bot: true },
  { kind: "verifier_failed", actions: ["retry", "fail"], bot: true },
  { kind: "repeated_failure", actions: ["retry", "fail"], bot: true },
  { kind: "preflight_failed", actions: ["retry", "fail"], bot: true },
  { kind: "external_outcome_unknown", actions: ["retry", "accept", "fail"], bot: false },
  { kind: "process_death_unconfirmed", actions: ["retry", "fail"], bot: false },
  { kind: "integrity_failed", actions: ["fail"], bot: false },
  { kind: "runtime_incompatible", actions: ["fail"], bot: false },
] as const;
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const emit = (text: string) => "printf '%s' " + quote(text);
const agent = (command: string) => ({ agent: { instructions: "Use evidence.", model: "fixture/model:low", harness: { command } } });
const blockVerifier = emit("<decision>block</decision>\n<reason>check effects</reason>");
const source = (node: unknown = { run: "printf candidate", verify: agent(blockVerifier) }, retries: number | "unlimited" = 0, environment?: unknown) =>
  JSON.stringify({ version: 4, defaults: { retries, replay: "safe" }, ...(environment === undefined ? {} : { environment }), steps: [{ work: node }, { later: "printf successor" }] });

async function withFixture(text: string, action: (fixture: Fixture) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "workshop-blocks-"));
  const opened = await openDurableStorage(join(directory, "durable.db"));
  if (!opened.ok) throw new Error(opened.failure.message);
  const tasks = defineWorkshopTasks();
  const registry = createRegistry();
  registry.install({ name: "blocks", tasks: [tasks.WorkflowRunTask, tasks.NodeAttemptTask, tasks.ProcessExecutionTask, tasks.CapacityGateTask] });
  const harness = await Harness.open(opened.storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
  try {
    const workflows = join(directory, ".workshop", "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(workflows, "blocks.yaml"), text);
    const installation = loadInstallation(directory);
    const definition = checkDefinitionText(text, "blocks.yaml", "blocks").def;
    const machine = { shell: "/bin/sh" };
    const at = new Date().toISOString();
    const prepared = prepareRunAdmission({
      sourceText: text, sourceLabel: "blocks.yaml", workflowId: "blocks", machineConfig: machine,
      resolvedSettings: resolveWorkflowSettings({ definition, machine, projectCwd: directory }),
      projectCwd: directory, runsDirectory: join(directory, "runs"), archiveDirectory: join(directory, "archive"),
      runtimeManifest: { durableVersion: "1.0.2", integrationManifestHash: "sha256:" + "1".repeat(64),
        taskVersions: { workflowRun: 10, nodeAttempt: 4, processExecution: 4, capacityGate: 1 } },
      runId: "blocks-" + randomUUID(), eventId: randomUUID(), activationId: "activation", occurrenceId: "occurrence", requestId: randomUUID(), admittedAt: at,
    });
    if (!prepared.ok) throw new Error(prepared.failure.message);
    await harness.commit(async (tx) => {
      Object.assign(await tx.doc(WorkshopInstallationDoc), installationDocumentV1Schema.parse({ state: "ready", installationId: "blocks", maxConcurrentRuns: 1,
        workflows: { blocks: { definitionHash: prepared.value.canonicalHash, admissionHighWater: 0, openRunId: null,
          activations: [{ activationId: "activation", state: "active", admittedCount: 0, maxRuns: 1, activatedAt: at, nextDueAt: null }],
          occurrenceCounters: { activation: 0 }, runs: [], requestIndex: {}, capacityReservations: [], preflightCache: {} } } }));
    }, BACKGROUND_CONTEXT);
    const admission = await admitPreparedRun({ harness, prepared: prepared.value, workflowRunTask: tasks.WorkflowRunTask,
      createTaskInput: createWorkflowRunTaskInput, parseTaskInput: parseWorkflowRunTaskInput, context: BACKGROUND_CONTEXT });
    if (!admission.ok) throw new Error(admission.failure.message);
    // SAFETY: admission returns the committed Durable conversation ID.
    const conversationId = admission.value.conversationId as ConversationId;
    const read = async () => {
      const run = workflowRunDocumentV1Schema.parse(await harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT));
      if (run.state !== "ready") throw new Error("fixture run disappeared");
      return run;
    };
    const edit = async (change: (run: ReadyRun) => ReadyRun) => {
      await harness.commit(async (tx) => { Object.assign(await tx.doc(WorkshopRunDoc, conversationId), workflowRunDocumentV1Schema.parse(change(await read()))); }, BACKGROUND_CONTEXT);
    };
    const resolve = (options: Omit<ResolveRequest, "version" | "method" | "workflowId" | "requestId" | "reason"> & { reason?: string; requestId?: string }) =>
      resolveBlockedWorkflow(harness, tasks, installation, { version: 1, method: "resolve", workflowId: "blocks", requestId: randomUUID(), reason: "check the saved evidence", ...options });
    await harness.resume();
    await harness.waitForIdle(BACKGROUND_CONTEXT);
    await action({ harness, tasks, directory, conversationId, read, edit, resolve });
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    rmSync(directory, { recursive: true, force: true });
  }
}
type Fixture = {
  harness: Harness;
  tasks: ReturnType<typeof defineWorkshopTasks>;
  directory: string;
  conversationId: ConversationId;
  read: () => Promise<ReadyRun>;
  edit: (change: (run: ReadyRun) => ReadyRun) => Promise<void>;
  resolve: (options: Omit<ResolveRequest, "version" | "method" | "workflowId" | "requestId" | "reason"> & { reason?: string; requestId?: string }) => Promise<unknown>;
};

async function changeBlock(fixture: Fixture, kind: BlockInfo["kind"], clearCandidate = false) {
  await fixture.edit((run) => {
    if (run.block === null) throw new Error("fixture has no block");
    const block = blockInfoSchema.parse({ ...run.block, kind });
    return { ...run, block,
      nodes: run.nodes.map((node) => ({ ...node, attempts: node.attempts.map((attempt) => attempt.result.kind !== "settled" || attempt.result.outcome.kind !== "blocked" ? attempt : {
        ...attempt, ...(clearCandidate ? { validatorExecutionId: null,
          supersededValidatorExecutionIds: attempt.validatorExecutionId === null ? [] : [attempt.validatorExecutionId] } : {}),
        result: { kind: "settled", outcome: { ...attempt.result.outcome, block,
          ...(clearCandidate ? { candidate: null, validator: null } : {}) } },
      }) })) };
  });
}

// The matrix tests the service seam, not just the pure table.
describe("block table authority", () => {
  for (const row of rows) for (const resolver of ["human", "bot"] as const) for (const action of ["retry", "accept", "fail"] as const) {
    test(row.kind + " " + resolver + " " + action, async () => {
      const text = row.kind === "preflight_failed" ? source(undefined, 0, { preflight: { command: "exit 7" } }) : source();
      await withFixture(text, async (fixture) => {
        if (row.kind !== "preflight_failed") await changeBlock(fixture, row.kind, row.kind === "external_outcome_unknown");
        const resultFile = join(fixture.directory, "human-result.txt");
        writeFileSync(resultFile, "human output");
        const request = { action, resolver,
          ...(action === "retry" && ["external_outcome_unknown", "process_death_unconfirmed"].includes(row.kind) ? { allowRepeat: true } : {}),
          ...(action === "accept" ? { resultFile, acknowledgeEffects: true } : {}),
        };
        const allowed = row.actions.some((value) => value === action) && (resolver === "human" || row.bot);
        if (!allowed) {
          await expect(fixture.resolve(request)).rejects.toThrow(/format 4/);
          expect((await fixture.read()).status).toBe("blocked");
          return;
        }
        expect(await fixture.resolve(request)).toMatchObject({ status: action === "fail" ? "failed" : "queued" });
        if (action === "fail") {
          const run = await fixture.read();
          expect(run.resolutions.at(-1)?.provenance).toBe(resolver);
          expect(run.failure).toMatchObject({ provenance: resolver });
        }
      });
    });
  }

  test("removed kinds, removed flags, bot accept, and unsafe retry flags are rejected", () => {
    for (const blockKind of ["retry_exhausted", "orchestrator", "orchestrator_unavailable", "orchestrator_invalid", "operator"] as const) {
      expect(checkBlockResolution({ formatVersion: 4, blockKind, action: "fail" })).toContain("no resolution authority");
    }
    for (const option of [{ extraAttempt: true }, { extraAttempt: false }, { target: "judgment" as const }]) {
      expect(checkBlockResolution({ formatVersion: 4, blockKind: "verifier_block", action: "retry", ...option })).toContain("removes");
    }
    expect(checkBlockResolution({ formatVersion: 4, blockKind: "external_outcome_unknown", action: "retry" })).toContain("requires --allow-repeat");
    expect(checkBlockResolution({ formatVersion: 4, blockKind: "process_death_unconfirmed", action: "retry" })).toContain("requires --allow-repeat");
    expect(checkBlockResolution({ formatVersion: 4, blockKind: "verifier_block", action: "retry", allowRepeat: true })).toContain("does not allow");
    expect(checkBlockResolution({ formatVersion: 4, blockKind: "verifier_block", action: "retry", resolver: "bot", allowRepeat: false })).toContain("requires a human");
    expect(checkBlockResolution({ formatVersion: 3, blockKind: "orchestrator", action: "retry", target: "judgment" })).toBeNull();
  });

  test("socket callers cannot claim bot authority", () => {
    const request = { version: 1, method: "resolve", workflowId: "blocks", requestId: "socket", action: "retry", reason: "inspect", resolver: "bot" };
    expect(serviceRequestV1Schema.safeParse(request).success).toBe(true);
    expect(parseServiceRequestLine(JSON.stringify(request))).toMatchObject({ ok: false, failure: { error: { code: "resolution_rejected" } } });
    expect(parseServiceRequestLine(JSON.stringify({ ...request, resolver: "human" })).ok).toBe(true);
  });
});

for (const kind of ["verifier_block", "verifier_failed", "repeated_failure", "preflight_failed"] as const) {
  test("one bot resolution per node: " + kind, async () => {
    await withFixture(kind === "preflight_failed" ? source(undefined, 0, { preflight: { command: "exit 7" } }) : source(), async (fixture) => {
      if (kind !== "preflight_failed") await changeBlock(fixture, kind);
      const before = await fixture.read();
      const requestId = randomUUID();
      const first = await fixture.resolve({ action: "retry", resolver: "bot", requestId, reason: "try one checked attempt" });
      expect(await fixture.resolve({ action: "retry", resolver: "bot", requestId, reason: "try one checked attempt" })).toEqual(first);
      await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
      const later = await fixture.read();
      expect(later.resolutions).toHaveLength(1);
      expect(later.resolutions[0]?.provenance).toBe("bot");
      expect(later.status).toBe("blocked");
      expect(later.block?.nodeId).toBe(before.block?.nodeId);
      await expect(fixture.resolve({ action: "retry", resolver: "bot" })).rejects.toThrow("a human must resolve later blocks");
      await expect(fixture.resolve({ action: "fail", resolver: "bot" })).rejects.toThrow("a human must resolve later blocks");
      expect(await fixture.resolve({ action: "fail", resolver: "human" })).toMatchObject({ status: "failed" });
    });
  });
}

for (const workerFailed of [false, true]) {
  test("broken verifier retries only saved " + (workerFailed ? "worker failure" : "candidate"), async () => {
    const verifier = "printf v >> verifier-launches; if [ ! -f repaired ]; then exit 7; fi; "
      + emit(workerFailed ? "<decision>retry</decision>\n<reason>worker must retry</reason>" : "<decision>accept</decision>\n<reason>checked</reason>");
    const node = { run: "printf w >> worker-launches; " + (workerFailed ? "printf failed >&2; exit 9" : "printf candidate"), verify: agent(verifier) };
    await withFixture(source(node, workerFailed ? 1 : 0), async (fixture) => {
      const before = await fixture.read();
      expect(before.block?.kind).toBe("verifier_failed");
      writeFileSync(join(fixture.directory, "repaired"), "yes");
      await fixture.resolve({ action: "retry", resolver: "human" });
      await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
      const after = await fixture.read();
      expect(readFileSync(join(fixture.directory, "verifier-launches"), "utf8")).toStartWith("vv");
      const original = after.nodes[0]?.attempts[0];
      expect(original?.attemptId).toBe(before.nodes[0]?.attempts[0]?.attemptId);
      const previousVerifier = before.nodes[0]?.attempts[0]?.validatorExecutionId;
      if (previousVerifier === null || previousVerifier === undefined) throw new Error("missing verifier receipt");
      expect(original?.supersededValidatorExecutionIds).toEqual([previousVerifier]);
      const metadata = serviceMetadataV1Schema.parse({ version: 1, status: "ready", pid: process.pid,
        startIdentity: "fixture", bootId: randomUUID(), startedAt: new Date().toISOString(), socketPath: "/unused.sock" });
      const projected = nodeDescriptionDtoSchema.parse(await projectServiceRead(fixture.harness, loadInstallation(fixture.directory), metadata,
        { version: 1, method: "node.describe", workflowId: "blocks", nodeId: "work" }));
      expect(projected.node.attempts[0]?.supersededValidatorExecutionIds).toEqual([previousVerifier]);
      expect(projected.node.attempts[0]?.processes.filter((process) => process.role === "worker")).toHaveLength(1);
      if (!workerFailed) {
        expect(after.status).toBe("completed");
        expect(after.nodes[0]?.attempts).toHaveLength(1);
        expect(readFileSync(join(fixture.directory, "worker-launches"), "utf8")).toBe("w");
        expect(after.terminalOutput).toBe("successor");
      } else {
        expect(readFileSync(join(fixture.directory, "worker-launches"), "utf8")).toBe("ww");
        expect(original?.status).toBe("failed");
      }
    });
  });
}

for (const mode of ["text", "tagged"] as const) {
  test("human acceptance parses " + mode + " with provenance and exact byte hash", async () => {
    const node = { run: mode === "text" ? "printf candidate" : emit("<status>succeeded</status>\n<output>candidate</output>"), result: mode };
    // A broken verifier supplies a real, retired worker receipt before the unknown-outcome fixture is installed.
    await withFixture(source({ ...node, verify: agent("exit 7") }), async (fixture) => {
      await changeBlock(fixture, "external_outcome_unknown", true);
      const bytes = mode === "text" ? "\ufeffhuman text\r\n" : "diagnostic\n<status>success_and_complete</status>\n<reason>done</reason>\n<output>human tagged</output>\ntrailer";
      const resultFile = join(fixture.directory, "supplied-result");
      writeFileSync(resultFile, bytes);
      if (mode === "tagged") {
        writeFileSync(resultFile, "invalid tags");
        await expect(fixture.resolve({ action: "accept", resultFile, acknowledgeEffects: true })).rejects.toThrow("result_invalid");
        writeFileSync(resultFile, bytes);
      }
      await expect(fixture.resolve({ action: "accept", resultFile })).rejects.toThrow("requires --result-file and --acknowledge-effects");
      const requestId = randomUUID();
      const accepted = await fixture.resolve({ action: "accept", resultFile, acknowledgeEffects: true, requestId });
      expect(await fixture.resolve({ action: "accept", resultFile, acknowledgeEffects: true, requestId })).toEqual(accepted);
      await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
      // The deliberately broken verifier still blocks. Acceptance cannot bypass it.
      const run = await fixture.read();
      expect(run.block?.kind).toBe("verifier_failed");
      const outcome = run.nodes[0]?.attempts[0]?.result;
      expect(outcome?.kind).toBe("settled");
      if (outcome?.kind !== "settled" || outcome.outcome.kind !== "blocked") throw new Error("missing accepted candidate");
      const candidate = outcome.outcome.candidate;
      const hash = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      expect(candidate).toMatchObject({ version: 2, source: "operator", sourceBytesHash: hash,
        acceptance: { provenance: "human", resultBytesHash: hash }, stdioResult: { mode, status: mode === "text" ? "succeeded" : "success_and_complete" } });
      expect(candidate?.output).toBe(mode === "text" ? bytes : "human tagged");
      expect(run.nodes[1]?.attempts).toHaveLength(0);
    });
  });
}

for (const race of ["block authority", "bot limit"] as const) {
  test("commit rechecks " + race + " after preparation", async () => withFixture(source(), async (fixture) => {
    const commit = fixture.harness.commit.bind(fixture.harness);
    let injected = false;
    // Interpose only the transaction boundary. All state reads and writes still use real SQLite commits.
    fixture.harness.commit = async (...args) => {
      if (!injected) {
        injected = true;
        await commit(async (tx) => {
          const draft = await tx.doc(WorkshopRunDoc, fixture.conversationId);
          const run = workflowRunDocumentV1Schema.parse(draft);
          if (run.state !== "ready" || run.block === null) throw new Error("race fixture lost its block");
          if (race === "block authority") {
            Object.assign(draft, { ...run, block: { ...run.block, kind: "integrity_failed" } });
          } else {
            const previousBlock = { ...run.block, blockId: "earlier-bot-block" };
            const previous = operatorResolutionSchema.parse({ resolutionId: "earlier-bot-resolution", provenance: "bot", action: "retry",
              reason: "already used", resolvedAt: new Date().toISOString(), processGroupsConfirmedDead: true,
              sourceBlock: previousBlock, allowRepeat: false, extraAttempt: false });
            Object.assign(draft, { ...run, resolutions: [...run.resolutions, previous] });
          }
        }, BACKGROUND_CONTEXT);
      }
      return commit(...args);
    };
    try {
      await expect(fixture.resolve({ action: "retry", resolver: race === "bot limit" ? "bot" : "human" })).rejects.toThrow(
        race === "bot limit" ? "a human must resolve later blocks" : "permits only fail");
      expect(injected).toBe(true);
      expect((await fixture.read()).status).toBe("blocked");
    } finally { fixture.harness.commit = commit; }
  }));
}

// A bot reason is engine-owned feedback; the next worker cannot turn it into authority.
test("bot reason reaches the next agent attempt without changing retries", async () => {
  await withFixture(source({ ...agent("cat > prompt-$WORKSHOP_ATTEMPT; " + emit("<status>succeeded</status>\n<output>candidate</output>")), verify: agent(blockVerifier) }), async (fixture) => {
    await fixture.resolve({ action: "retry", resolver: "bot", reason: "use the checked receipt" });
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    const run = await fixture.read();
    if (!("formatVersion" in run.resolvedSettings) || run.resolvedSettings.formatVersion !== 4) throw new Error("not format 4");
    expect(run.resolvedSettings.nodes.work?.retries).toBe(0);
    expect(run.nodes[0]?.attempts).toHaveLength(2);
    expect(readFileSync(join(fixture.directory, "prompt-2"), "utf8")).toContain("Bot resolution: use the checked receipt");
    expect(run.resolutions[0]?.reason).toBe("use the checked receipt");
  });
});

for (const status of ["success_and_complete", "needs_input"] as const) {
  test("human tagged acceptance preserves " + status + " semantics", async () => {
    const verifier = "if [ ! -f repaired ]; then exit 7; fi; " + emit("<decision>accept</decision>\n<reason>checked</reason>");
    await withFixture(source({ run: emit("<status>succeeded</status>\n<output>candidate</output>"), result: "tagged", verify: agent(verifier) }), async (fixture) => {
      await changeBlock(fixture, "external_outcome_unknown", true);
      const resultFile = join(fixture.directory, "human-result");
      const bytes = "<status>" + status + "</status>\n" + (status === "needs_input" ? "<question>Approve?</question>\n" : "") + "<output>human proposal</output>";
      writeFileSync(resultFile, bytes);
      writeFileSync(join(fixture.directory, "repaired"), "yes");
      await fixture.resolve({ action: "accept", resultFile, acknowledgeEffects: true });
      await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
      const run = await fixture.read();
      expect(run.status).toBe(status === "needs_input" ? "waiting" : "completed");
      if (status === "needs_input") expect(run.waits?.[0]).toMatchObject({ question: "Approve?", output: "human proposal" });
      else {
        expect(run.terminalOutput).toBe("human proposal");
        expect(run.nodes[1]?.status).toBe("skipped");
      }
      expect(run.nodes[1]?.attempts).toHaveLength(0);
    });
  });
}

test("preflight bot reason reaches the first agent worker", async () => {
  const text = source(agent("cat > first-prompt; " + emit("<status>succeeded</status>\n<output>candidate</output>")), 0,
    { preflight: { command: "test -f repaired" } });
  await withFixture(text, async (fixture) => {
    expect((await fixture.read()).block?.kind).toBe("preflight_failed");
    writeFileSync(join(fixture.directory, "repaired"), "yes");
    await fixture.resolve({ action: "retry", resolver: "bot", reason: "configuration is now repaired" });
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect((await fixture.read()).status).toBe("completed");
    expect(readFileSync(join(fixture.directory, "first-prompt"), "utf8")).toContain("Bot resolution: configuration is now repaired");
  });
});

test("repeated failure resolution grants exactly one extra attempt", async () => {
  await withFixture(source({ run: "printf w >> worker-launches; printf identical >&2; exit 9" }, 1), async (fixture) => {
    expect((await fixture.read()).block?.kind).toBe("repeated_failure");
    await fixture.resolve({ action: "retry", resolver: "human" });
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    const run = await fixture.read();
    expect(run.block?.kind).toBe("repeated_failure");
    expect(run.nodes[0]?.attempts).toHaveLength(3);
    expect(readFileSync(join(fixture.directory, "worker-launches"), "utf8")).toBe("www");
  });
});

test("concurrent human and bot resolutions commit one decision", async () => {
  await withFixture(source(), async (fixture) => {
    const outcomes = await Promise.allSettled([
      fixture.resolve({ action: "retry", resolver: "human" }),
      fixture.resolve({ action: "retry", resolver: "bot" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    const run = await fixture.read();
    expect(run.resolutions).toHaveLength(1);
    expect(run.nodes[0]?.attempts).toHaveLength(2);
  });
});

test("bot resolution limit belongs to each node, not the whole run", async () => {
  const firstVerifier = "if [ -f first-repaired ]; then " + emit("<decision>accept</decision>\n<reason>checked</reason>") + "; else " + blockVerifier + "; fi";
  const text = JSON.stringify({ version: 4, defaults: { retries: 0, replay: "safe" }, steps: [
    { work: { run: "printf first", verify: agent(firstVerifier) } },
    { later: { run: "printf later", verify: agent(blockVerifier) } },
  ] });
  await withFixture(text, async (fixture) => {
    await fixture.resolve({ action: "retry", resolver: "bot" });
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    writeFileSync(join(fixture.directory, "first-repaired"), "yes");
    await fixture.resolve({ action: "retry", resolver: "human" });
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect((await fixture.read()).block?.nodeId).toBe("later");
    await fixture.resolve({ action: "retry", resolver: "bot" });
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    const run = await fixture.read();
    expect(run.resolutions.filter((resolution) => resolution.provenance === "bot").map((resolution) => resolution.sourceBlock.nodeId)).toEqual(["work", "later"]);
    await expect(fixture.resolve({ action: "retry", resolver: "bot" })).rejects.toThrow("a human must resolve later blocks");
  });
});
