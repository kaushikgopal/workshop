import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { checkDefinitionText } from "../../src/definition/check-definition.js";
import { resolveWorkflowSettings } from "../../src/definition/resolve-workflow-settings.js";
import { installationDocumentV1Schema } from "../../src/installation/schema.js";
import { prepareRunAdmission } from "../../src/run/prepare-admission.js";
import { workshopProcessV1Schema } from "../../src/run/records.js";
import { admitPreparedRun } from "../../src/storage/durable/admit-run.js";
import { WorkshopInstallationDoc } from "../../src/storage/durable/define-workshop-records.js";
import { createWorkflowRunTaskInput, defineWorkshopTasks, parseWorkflowRunTaskInput } from "../../src/storage/durable/define-workshop-tasks.js";
import { openDurableStorage } from "../../src/storage/durable/open-durable-storage.js";

const [mode, directory, databasePath, readyPath, metadataPath] = process.argv.slice(2);
if (mode !== "worker" && mode !== "identity" && mode !== "safe-worker" && mode !== "safe-validator" && mode !== "preflight") {
  throw new Error("mode must be worker, identity, safe-worker, safe-validator, or preflight");
}
if (directory === undefined || databasePath === undefined || readyPath === undefined || metadataPath === undefined) {
  throw new Error("crash harness requires directory, database, ready, and metadata paths");
}

const safeReplay = mode === "safe-worker" || mode === "safe-validator";
const preflightMode = mode === "preflight";
// Verifiers always replay after a crash, so only the replaying validator mode remains.
const validatorMode = mode === "safe-validator";
const workerMarker = `'${join(directory, "workers.txt")}'`;
const validatorMarker = `'${join(directory, "validators.txt")}'`;
const processGroupMarker = `'${join(directory, "process-group.txt")}'`;
const successorMarker = `'${join(directory, "successors.txt")}'`;
const preflightMarker = `'${join(directory, "preflight.txt")}'`;
const workerCommand = safeReplay && !validatorMode
  ? `printf w >> ${workerMarker}; if [ "$(wc -c < ${workerMarker})" -eq 1 ]; then printf '%s' "$$" > ${processGroupMarker}; (/bin/sleep 60) & wait; else printf replayed; fi`
  : `printf w >> ${workerMarker}; printf '%s' "$$" > ${processGroupMarker}; (/bin/sleep 60) & wait`;
const validatorCommand = safeReplay && validatorMode
  ? `printf v >> ${validatorMarker}; if [ "$(wc -c < ${validatorMarker})" -eq 1 ]; then printf '%s' "$$" > ${processGroupMarker}; (/bin/sleep 60) & wait; else printf validator-passed; fi`
  : `printf v >> ${validatorMarker}; printf '%s' "$$" > ${processGroupMarker}; (/bin/sleep 60) & wait`;
const preflightCommand = `printf p >> ${preflightMarker}; if [ "$(wc -c < ${preflightMarker})" -eq 1 ]; then printf '%s' "$$" > ${processGroupMarker}; (/bin/sleep 60) & wait; else printf preflight-ready; fi`;
const header = ["version: 4", "defaults:", "  retries: 0", "  replay: never"];
const source = [...header, ...(preflightMode ? [
  "environment:",
  "  preflight:",
  "    timeout: 5s",
  "    command: >-",
  `      ${preflightCommand}`,
  "steps:",
  "  - first:",
  "      run: >-",
  `        printf w >> ${workerMarker}; printf preflight-worker`,
  "",
] : !validatorMode ? [
  "steps:",
  "  - first:",
  "      timeout: 5s",
  ...(safeReplay ? ["      replay: safe"] : []),
  "      run: >-",
  `        ${workerCommand}`,
  "  - second:",
  "      run: >-",
  `        printf s >> ${successorMarker}; printf '%s-next' \"$(cat \"$WORKSHOP_PREVIOUS_OUTPUT_FILE\")\"`,
  "",
] : [
  "steps:",
  "  - first:",
  "      run: >-",
  `        printf w >> ${workerMarker}; printf candidate`,
  "      verify:",
  "        run: >-",
  `          ${validatorCommand}`,
  "  - second:",
  "      run: >-",
  `        printf s >> ${successorMarker}; printf '%s-next' \"$(cat \"$WORKSHOP_PREVIOUS_OUTPUT_FILE\")\"`,
  "",
])].join("\n");

const machine = {
  shell: "/bin/bash",
  ...(mode === "identity" ? { orchestrator: { model: "missing/failure-judge:low", timeout: "10s" } } : {}),
} as const;
const checked = checkDefinitionText(source, "crash-recovery.yaml", "command-chain");
const resolvedSettings = resolveWorkflowSettings({ definition: checked.def, machine, projectCwd: directory });
const preparedResult = prepareRunAdmission({
  sourceText: source,
  sourceLabel: "crash-recovery.yaml",
  workflowId: "command-chain",
  machineConfig: machine,
  projectCwd: directory,
  runsDirectory: join(directory, "state", "runs"),
  archiveDirectory: join(directory, ".workshop", "archive"),
  resolvedSettings,
  runtimeManifest: {
    durableVersion: "1.0.2",
    integrationManifestHash: `sha256:${createHash("sha256").update("durable crash recovery test").digest("hex")}`,
    taskVersions: { workflowRun: 10, nodeAttempt: 4, processExecution: 4, capacityGate: 1, failureJudgment: 1 },
  },
  runId: `command-chain-crash-recovery-${mode}`,
  eventId: `crash-recovery-${mode}-admission`,
  activationId: "activation-crash-recovery",
  occurrenceId: `occurrence-crash-recovery-${mode}`,
  requestId: `crash-recovery-${mode}-request`,
  admittedAt: new Date().toISOString(),
});
if (!preparedResult.ok) throw new Error(`${preparedResult.failure.kind}: ${preparedResult.failure.message}`);

const opened = await openDurableStorage(databasePath);
if (!opened.ok) throw new Error(`${opened.failure.message}: ${String(opened.failure.cause)}`);
const tasks = defineWorkshopTasks();
const registry = createRegistry();
registry.install({
  name: "workshop-crash-recovery-test",
  tasks: [tasks.WorkflowRunTask, tasks.NodeAttemptTask, tasks.ProcessExecutionTask, tasks.CapacityGateTask, tasks.FailureJudgmentTask],
});
registry.install(tasks.FailureJudgmentExtension);
const harness = await Harness.open(opened.storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
const installation = installationDocumentV1Schema.parse({
  state: "ready",
  installationId: "installation-crash-recovery-test",
  maxConcurrentRuns: 1,
  workflows: {
    "command-chain": {
      definitionHash: preparedResult.value.canonicalHash,
      admissionHighWater: 0,
      openRunId: null,
      activations: [{
        activationId: "activation-crash-recovery",
        state: "active",
        admittedCount: 0,
        maxRuns: 1,
        activatedAt: new Date(Date.now() - 1_000).toISOString(),
        nextDueAt: null,
      }],
      occurrenceCounters: { "activation-crash-recovery": 0 },
      runs: [],
      requestIndex: {},
      capacityReservations: [],
      preflightCache: {},
    },
  },
});
await harness.commit(async (tx) => {
  Object.assign(await tx.doc(WorkshopInstallationDoc), installation);
}, BACKGROUND_CONTEXT);
const admission = await admitPreparedRun({
  harness,
  prepared: preparedResult.value,
  workflowRunTask: tasks.WorkflowRunTask,
  createTaskInput: createWorkflowRunTaskInput,
  parseTaskInput: parseWorkflowRunTaskInput,
  context: BACKGROUND_CONTEXT,
});
if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
void harness.waitForIdle(BACKGROUND_CONTEXT);
const conversation = await harness.conversation(admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT);
if (conversation === undefined) throw new Error("run conversation is missing after admission");
writeFileSync(metadataPath, JSON.stringify({ conversationId: admission.value.conversationId, workflowTaskId: admission.value.workflowTaskId }));

const targetRole = preflightMode ? "preflight" : validatorMode ? "validator" : "worker";
const targetStatus = mode === "identity" ? "blocked" : "running";
for (let attempt = 0; attempt < 2_000; attempt += 1) {
  const entries = await conversation.entries({}, 1_000, undefined, BACKGROUND_CONTEXT);
  const processStarted = entries.items
    .filter((entry) => entry.kind === "workshop.process")
    .map((entry) => workshopProcessV1Schema.parse(entry.data))
    .some((entry) => entry.process.role === targetRole && entry.process.status === targetStatus
      && (mode !== "identity" || entry.process.identity === null));
  if (processStarted) {
    writeFileSync(readyPath, "running");
    setInterval(() => undefined, 1_000);
    await new Promise<void>(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
throw new Error(`timed out waiting for ${targetRole} process state ${targetStatus}`);
