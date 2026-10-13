import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { loadInstallation, loadCheckedWorkflow } from "../src/installation/load-installation.js";
import { installationDocumentV1Schema } from "../src/installation/schema.js";
import { workshopProcessV1Schema } from "../src/run/records.js";
import { serviceLogSectionPageV1Schema, serviceRunsPageV1Schema, serviceStartResultV1Schema } from "../src/service/schema.js";
import { probeServiceHealth } from "../src/service/probe-service-health.js";
import { readServiceWorklog, sendServiceRequest, streamServiceLogChunks } from "../src/service/send-service-request.js";
import { acquireServiceLock } from "../src/service/acquire-service-lock.js";
import { WorkshopInstallationDoc, WorkshopProcessEntry } from "../src/storage/durable/define-workshop-records.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import { format4ResolutionRejection, startWorkshopService } from "../src/service/open-service-runtime.js";
import { logsDtoSchema, nodeDescriptionDtoSchema, statusDtoSchema, type LogsDto } from "../src/views/schema.js";

async function waitForCompletedRun(socketPath: string, workflowId: string, runId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await sendServiceRequest(socketPath, { version: 1, method: "runs", workflowId, limit: 100 });
    if (!response.ok) throw new Error(response.error.message);
    const page = serviceRunsPageV1Schema.parse(response.result);
    const run = page.runs.find((candidate) => candidate.runId === runId);
    if (run?.status === "completed") return;
    if (run?.status === "failed" || run?.status === "blocked" || run?.status === "cancelled") {
      throw new Error(`run ${runId} settled as ${run.status}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`run ${runId} did not complete before the fixture deadline`);
}


describe("Durable service runtime", () => {
  test("limits format 4 runtime and integrity blocks to fail", () => {
    expect(format4ResolutionRejection({ formatVersion: 4, blockKind: "runtime_incompatible", action: "retry" }))
      .toContain("permit only fail");
    expect(format4ResolutionRejection({ formatVersion: 4, blockKind: "integrity_failed", action: "retry" }))
      .toContain("permit only fail");
    expect(format4ResolutionRejection({ formatVersion: 4, blockKind: "integrity_failed", action: "accept" }))
      .toContain("WP6 must define human text/tagged acceptance");
    expect(format4ResolutionRejection({ formatVersion: 4, blockKind: "runtime_incompatible", action: "fail" })).toBeNull();
    expect(format4ResolutionRejection({ formatVersion: 4, blockKind: "integrity_failed", action: "fail" })).toBeNull();
    expect(format4ResolutionRejection({ formatVersion: 4, blockKind: "orchestrator_unavailable", action: "retry" })).toBeNull();
    expect(format4ResolutionRejection({ formatVersion: 3, blockKind: "runtime_incompatible", action: "retry" })).toBeNull();
  });
  test("serves start, status, runs, and logs for one canonical run through real SQLite and Harness resources", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-service-runtime-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\nkeep_files: always\n", "utf8");
    writeFileSync(join(workflows, "clock.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "description: Durable service fixture",
      "steps:",
      "  - tick:",
      "      run: sleep 0.3; printf 'fixture-output'",
      "",
    ].join("\n"), "utf8");

    const installation = loadInstallation(root);
    const checked = loadCheckedWorkflow(installation, "clock");
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(installation);
      const health = await probeServiceHealth(installation.stateDirectory);
      expect(health.kind).toBe("ready");
      if (health.kind !== "ready") throw new Error(health.reason);
      const socketPath = health.metadata.socketPath;

      const startedResponse = await sendServiceRequest(socketPath, {
        version: 1,
        method: "start",
        requestId: "fixture-start-1",
        workflowId: "clock",
      });
      if (!startedResponse.ok) throw new Error(`${startedResponse.error.code}: ${startedResponse.error.message}`);
      const started = serviceStartResultV1Schema.parse(startedResponse.result);
      expect(started.workflowId).toBe("clock");
      expect(started.duplicate).toBe(false);

      const during = await sendServiceRequest(socketPath, { version: 1, method: "status", workflowId: "clock" });
      expect(during.ok).toBe(true);
      if (!during.ok) throw new Error(during.error.message);
      const activeStatus = statusDtoSchema.parse(during.result);
      expect(activeStatus.workflows[0]?.unresolvedRun?.runId).toBe(started.runId);
      expect(activeStatus.workflows[0]?.definitionHash).toBe(checked.canonicalHash);

      let page: ReturnType<typeof serviceRunsPageV1Schema.parse> | undefined;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const response = await sendServiceRequest(socketPath, { version: 1, method: "runs", workflowId: "clock", limit: 1 });
        expect(response.ok).toBe(true);
        if (!response.ok) throw new Error(response.error.message);
        page = serviceRunsPageV1Schema.parse(response.result);
        if (page.runs[0]?.status === "completed") break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      expect(page?.runs).toHaveLength(1);
      expect(page?.runs[0]?.status).toBe("completed");
      expect(page?.runs[0]?.runId).toBe(started.runId);
      expect(page?.highWaterMark).toBe(1);

      const logSections: LogsDto["sections"] = [];
      const logStream = await streamServiceLogChunks(socketPath, "clock", started.runId, (section, _runId, chunk) => {
        expect(chunk.complete).toBe(true);
        logSections.push(section);
      });
      const logs = logsDtoSchema.parse({ version: 2, runId: logStream.runId, sections: logSections });
      expect(logs.runId).toBe(started.runId);
      expect(logs.sections.some((section) => section.kind === "capture" && section.content === "fixture-output")).toBe(true);

      const pagedSectionIds: string[] = [];
      const pagedContents: (string | null)[] = [];
      let logsCursor: string | undefined;
      let logsSectionCount: number | undefined;
      do {
        const pageResponse = await sendServiceRequest(socketPath, {
          version: 1, method: "logs.page", workflowId: "clock", runId: started.runId,
          ...(logsCursor === undefined ? {} : { cursor: logsCursor }),
        });
        if (!pageResponse.ok) throw new Error(`${pageResponse.error.code}: ${pageResponse.error.message}`);
        const page = serviceLogSectionPageV1Schema.parse(pageResponse.result);
        expect(page.runId).toBe(started.runId);
        expect(page.sectionIndex).toBe(pagedSectionIds.length);
        if (logsSectionCount === undefined) logsSectionCount = page.totalSections;
        expect(page.totalSections).toBe(logsSectionCount);
        pagedSectionIds.push(page.section.sectionId);
        pagedContents.push(page.section.content);
        logsCursor = page.nextCursor ?? undefined;
      } while (logsCursor !== undefined);
      expect(pagedSectionIds).toEqual(logs.sections.map((section) => section.sectionId));
      expect(pagedContents).toEqual(logs.sections.map((section) => section.content));
      expect(new Set(pagedSectionIds).size).toBe(pagedSectionIds.length);
      expect(pagedSectionIds).toHaveLength(logsSectionCount);
      const invalidLogsCursor = await sendServiceRequest(socketPath, { version: 1, method: "logs.page", workflowId: "clock", runId: started.runId, cursor: "!" });
      expect(invalidLogsCursor.ok).toBe(false);

      const after = await sendServiceRequest(socketPath, { version: 1, method: "status", workflowId: "clock" });
      expect(after.ok).toBe(true);
      if (!after.ok) throw new Error(after.error.message);
      const finalStatus = statusDtoSchema.parse(after.result);
      expect(finalStatus.workflows[0]?.unresolvedRun).toBeNull();
      expect(finalStatus.workflows[0]?.definitionHash).toBe(checked.canonicalHash);
      const second = await startCompletedRun(socketPath, "fixture-start-2");
      const third = await startCompletedRun(socketPath, "fixture-start-3");
      const firstPageResponse = await sendServiceRequest(socketPath, { version: 1, method: "runs", workflowId: "clock", limit: 1 });
      if (!firstPageResponse.ok) throw new Error(firstPageResponse.error.message);
      const firstPage = serviceRunsPageV1Schema.parse(firstPageResponse.result);
      expect(firstPage.total).toBe(3);
      expect(firstPage.highWaterMark).toBe(3);
      expect(firstPage.runs).toHaveLength(1);
      expect(firstPage.nextCursor).not.toBeNull();

      const fourth = await startCompletedRun(socketPath, "fixture-start-4");
      const snapshotRuns = [...firstPage.runs];
      let cursor = firstPage.nextCursor;
      while (cursor !== null) {
        const response = await sendServiceRequest(socketPath, { version: 1, method: "runs", workflowId: "clock", limit: 1, cursor });
        if (!response.ok) throw new Error(response.error.message);
        const nextPage = serviceRunsPageV1Schema.parse(response.result);
        expect(nextPage.total).toBe(3);
        expect(nextPage.highWaterMark).toBe(3);
        snapshotRuns.push(...nextPage.runs);
        cursor = nextPage.nextCursor;
      }
      expect(snapshotRuns).toHaveLength(3);
      expect(new Set(snapshotRuns.map((run) => run.runId))).toEqual(new Set([started.runId, second.runId, third.runId]));
      expect(snapshotRuns.some((run) => run.runId === fourth.runId)).toBe(false);

      const freshPageResponse = await sendServiceRequest(socketPath, { version: 1, method: "runs", workflowId: "clock", limit: 4 });
      if (!freshPageResponse.ok) throw new Error(freshPageResponse.error.message);
      const freshPage = serviceRunsPageV1Schema.parse(freshPageResponse.result);
      expect(freshPage.total).toBe(4);
      expect(freshPage.highWaterMark).toBe(4);
      const invalidCursor = await sendServiceRequest(socketPath, { version: 1, method: "runs", workflowId: "clock", limit: 1, cursor: "!" });
      expect(invalidCursor.ok).toBe(false);
      await owner.shutdown();
      owner = undefined;
      const reclaimedLock = acquireServiceLock(join(installation.stateDirectory, "service.lock"));
      try {
        const reopened = await openDurableStorage(installation.databasePath);
        expect(reopened.ok).toBe(true);
        if (!reopened.ok) throw new Error(reopened.failure.message);
        await reopened.storage.close(BACKGROUND_CONTEXT);
      } finally {
        reclaimedLock.release();
      }
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repairs an unavailable judge and retries only the judgment before authorizing a new attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-judgment-repair-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const workerLaunches = join(root, "worker-launches.txt");
    const validatorLaunches = join(root, "validator-launches.txt");
    const validatorFirstFailure = join(root, "validator-first-failure.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\norchestrator:\n  model: faux/failure-judge:low\n  timeout: 20s\n", "utf8");
    writeFileSync(join(workflows, "judgment-repair.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - verify:",
      "      retries: 1",
      "      replay: safe",
      "      run: >-",
      `        printf w >> '${workerLaunches}'; printf candidate`,
      "      verify:",
      "        run: >-",
      `          printf v >> '${validatorLaunches}'; if [ ! -e '${validatorFirstFailure}' ]; then touch '${validatorFirstFailure}'; exit 7; fi; exit 0`,
      "",
    ].join("\n"), "utf8");
    const installation = loadInstallation(root);
    const models = createModels();
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    let releaseDecision!: () => void;
    const decisionReleased = new Promise<void>((resolve) => { releaseDecision = resolve; });
    let providerWaiting = false;
    faux.setResponses([async () => {
      providerWaiting = true;
      await decisionReleased;
      return fauxAssistantMessage(fauxToolCall("record_workshop_failure_decision", { action: "retry", reason: "A repaired judge authorized one safe new attempt." }), { stopReason: "toolUse" });
    }]);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    const count = (path: string) => existsSync(path) ? readFileSync(path, "utf8").length : 0;
    try {
      owner = await startWorkshopService(installation, { models });
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const socketPath = health.metadata.socketPath;
      const started = await sendServiceRequest(socketPath, { version: 1, method: "start", requestId: "judgment-repair-start", workflowId: "judgment-repair" });
      if (!started.ok) throw new Error(started.error.message);
      const startResult = serviceStartResultV1Schema.parse(started.result);
      let blocked: ReturnType<typeof statusDtoSchema.parse> | undefined;
      const blockDeadline = Date.now() + 10_000;
      while (Date.now() < blockDeadline) {
        const response = await sendServiceRequest(socketPath, { version: 1, method: "status", workflowId: "judgment-repair" });
        if (!response.ok) throw new Error(response.error.message);
        const status = statusDtoSchema.parse(response.result);
        if (status.workflows[0]?.unresolvedRun?.status === "blocked") { blocked = status; break; }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      if (blocked === undefined) throw new Error("workflow did not block on the unavailable native judge");
      expect(blocked.workflows[0]?.unresolvedRun?.block?.kind).toBe("orchestrator_unavailable");
      expect(count(workerLaunches)).toBe(1);
      expect(count(validatorLaunches)).toBe(1);
      const unsupportedAcceptance = await sendServiceRequest(socketPath, {
        version: 1, method: "resolve", requestId: "judgment-repair-accept", workflowId: "judgment-repair",
        runId: startResult.runId, action: "accept", reason: "Test the temporary format 4 acceptance guard.",
        resultFile: "candidate.json", acknowledgeEffects: true,
      });
      expect(unsupportedAcceptance.ok).toBe(false);
      if (unsupportedAcceptance.ok) throw new Error("format 4 file acceptance unexpectedly succeeded");
      expect(unsupportedAcceptance.error.code).toBe("resolution_rejected");
      expect(unsupportedAcceptance.error.message).toContain("format 4 accept --result-file is not supported yet");
      expect(unsupportedAcceptance.error.message).toContain("WP6 must define human text/tagged acceptance");
      models.setProvider(faux.provider);
      const resolved = await sendServiceRequest(socketPath, {
        version: 1, method: "resolve", requestId: "judgment-repair-rejudge", workflowId: "judgment-repair",
        runId: startResult.runId, action: "retry", target: "judgment", reason: "Credentials were repaired; ask the same failed attempt again.",
      });
      if (!resolved.ok) throw new Error(resolved.error.message);
      expect(resolved.result).toMatchObject({ workflowId: "judgment-repair", runId: startResult.runId, status: "queued" });
      const callDeadline = Date.now() + 10_000;
      while (Date.now() < callDeadline && (!providerWaiting || faux.state.callCount !== 1)) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      expect(providerWaiting).toBe(true);
      expect(faux.state.callCount).toBe(1);
      const duringJudge = await sendServiceRequest(socketPath, { version: 1, method: "node.describe", workflowId: "judgment-repair", runId: startResult.runId, nodeId: "verify" });
      if (!duringJudge.ok) throw new Error(duringJudge.error.message);
      const nodeBeforeDecision = nodeDescriptionDtoSchema.parse(duringJudge.result).node;
      expect(nodeBeforeDecision.attempts).toHaveLength(1);
      expect(nodeBeforeDecision.attempts[0]?.number).toBe(1);
      expect(nodeBeforeDecision.attempts[0]?.status).toBe("failed");
      expect(count(workerLaunches)).toBe(1);
      expect(count(validatorLaunches)).toBe(1);
      releaseDecision();
      let finalNode: ReturnType<typeof nodeDescriptionDtoSchema.parse> | undefined;
      const retryDeadline = Date.now() + 10_000;
      while (Date.now() < retryDeadline) {
        const response = await sendServiceRequest(socketPath, { version: 1, method: "node.describe", workflowId: "judgment-repair", runId: startResult.runId, nodeId: "verify" });
        if (!response.ok) throw new Error(response.error.message);
        finalNode = nodeDescriptionDtoSchema.parse(response.result);
        if (finalNode.runStatus === "completed" && finalNode.node.attempts.length === 2) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      if (finalNode?.runStatus !== "completed") {
        const status = await sendServiceRequest(socketPath, { version: 1, method: "status", workflowId: "judgment-repair" });
        throw new Error(`judgment repair did not complete: ${JSON.stringify({ finalNode, status: status.ok ? status.result : status.error, providerCalls: faux.state.callCount })}`);
      }
      expect(finalNode?.node.attempts.map((attempt) => attempt.number)).toEqual([1, 2]);
      expect(finalNode?.node.attempts[0]?.blocks.some((block) => block.kind === "orchestrator_unavailable")).toBe(true);
      expect(finalNode?.node.attempts[0]?.judgments).toHaveLength(1);
      expect(count(workerLaunches)).toBe(2);
      expect(count(validatorLaunches)).toBe(2);
    } finally {
      releaseDecision();
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
  test("renders committed capture text, marks unavailable content, and skips empty captures", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-log-text-integrity-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    mkdirSync(workflows, { recursive: true });
    const harnessCommand = String.raw`printf '<status>succeeded</status>\n<output>candidate</output>'
case "$WORKSHOP_STEP_ID" in
  bom) printf '\357\273\277raw-bom' >&2 ;;
  invalid) printf '\377raw-invalid' >&2 ;;
  readable) printf 'other sections remain readable' >&2 ;;
  empty) : ;;
esac`;
    writeFileSync(join(config, "workshop.yaml"), `shell: /bin/sh\nkeep_files: always\nagent:\n  model: fixture/mock-model:medium\n  harness:\n    command: |\n${harnessCommand.split("\n").map((line) => `      ${line}`).join("\n")}\n`, "utf8");
    writeFileSync(join(workflows, "capture-text.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - bom:",
      "      agent: Return the fixture result.",
      "  - invalid:",
      "      agent: Return the fixture result.",
      "  - readable:",
      "      agent: Return the fixture result.",
      "  - empty:",
      "      agent: Return the fixture result.",
      "",
    ].join("\n"), "utf8");
    const installation = loadInstallation(root);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(installation);
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const startedResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "start", requestId: "capture-text-start", workflowId: "capture-text",
      });
      if (!startedResponse.ok) throw new Error(startedResponse.error.message);
      const started = serviceStartResultV1Schema.parse(startedResponse.result);
      await waitForCompletedRun(health.metadata.socketPath, "capture-text", started.runId);
      const logSections: LogsDto["sections"] = [];
      const logStream = await streamServiceLogChunks(health.metadata.socketPath, "capture-text", started.runId, (section, _runId, chunk) => {
        expect(chunk.complete).toBe(true);
        logSections.push(section);
      });
      const logs = logsDtoSchema.parse({ version: 2, runId: logStream.runId, sections: logSections });
      const bom = logs.sections.find((section) => section.kind === "capture" && section.label === "bom worker stderr");
      const unavailable = logs.sections.find((section) => section.kind === "capture" && section.label === "invalid worker stderr");
      const readable = logs.sections.find((section) => section.kind === "capture" && section.label === "readable worker stderr");
      expect(bom?.kind).toBe("capture");
      if (bom?.kind !== "capture") throw new Error("BOM capture section is missing");
      expect(bom.content).toBe("\uFEFFraw-bom");
      expect(unavailable?.kind).toBe("capture");
      if (unavailable?.kind !== "capture") throw new Error("unavailable capture section is missing");
      expect(unavailable.content).toBe("[invalid UTF-8; base64 bytes]\n/3Jhdy1pbnZhbGlk");
      expect(readable?.kind).toBe("capture");
      if (readable?.kind !== "capture") throw new Error("readable capture section is missing");
      expect(readable.content).toBe("other sections remain readable");
      expect(logs.sections.some((section) => section.kind === "capture" && section.label === "empty worker stderr")).toBe(false);
      const worklog = logs.sections.find((section) => section.kind === "worklog");
      expect(worklog?.kind).toBe("worklog");
      if (worklog?.kind !== "worklog") throw new Error("worklog section is missing");
      expect(worklog.content.length).toBeGreaterThan(0);

      const pages = [];
      let cursor: string | undefined;
      do {
        const pageResponse = await sendServiceRequest(health.metadata.socketPath, {
          version: 1, method: "logs.page", workflowId: "capture-text", runId: started.runId,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (!pageResponse.ok) throw new Error(pageResponse.error.message);
        const page = serviceLogSectionPageV1Schema.parse(pageResponse.result);
        pages.push(page.section);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(pages.map((section) => section.sectionId)).toEqual(logs.sections.map((section) => section.sectionId));
      expect(pages.find((section) => section.kind === "capture" && section.label === "invalid worker stderr")?.content).toContain("base64 bytes");
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("keeps large stderr diagnostics separate from tagged worker output", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-large-stderr-diagnostic-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const validatorLaunch = join(root, "validator-launched");
    const successorLaunch = join(root, "successor-launched");
    mkdirSync(workflows, { recursive: true });
    const harnessCommand = [
      "printf '<status>succeeded</status>\\n<output>candidate</output>'",
      "head -c 70000 /dev/zero | tr '\\000' x >&2",
    ].join("\n");
    writeFileSync(join(config, "workshop.yaml"), [
      "shell: /bin/sh",
      "keep_files: always",
      "stream_cap: 1kb",
      "agent:",
      "  model: fixture/mock-model:medium",
      "  harness:",
      "    command: |",
      ...harnessCommand.split("\n").map((line) => "      " + line),
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "large-stderr.yaml"), [
      "version: 4",
      "defaults: { retries: 0, replay: never }",
      "steps:",
      "  - worker:",
      "      agent: Return the fixture result.",
      "      verify:",
      "        run: 'test \"$(cat)\" = candidate; printf launched > " + validatorLaunch + "'",
      "  - successor:",
      "      run: 'test \"$(cat)\" = candidate; printf launched > " + successorLaunch + "; printf completed'",
      "",
    ].join("\n"), "utf8");
    const installation = loadInstallation(root);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(installation);
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const startedResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "start", requestId: "large-stderr-start", workflowId: "large-stderr",
      });
      if (!startedResponse.ok) throw new Error(startedResponse.error.message);
      const started = serviceStartResultV1Schema.parse(startedResponse.result);
      await waitForCompletedRun(health.metadata.socketPath, "large-stderr", started.runId);
      const descriptionResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "node.describe", workflowId: "large-stderr", nodeId: "worker", runId: started.runId,
      });
      if (!descriptionResponse.ok) throw new Error(descriptionResponse.error.message);
      expect(nodeDescriptionDtoSchema.parse(descriptionResponse.result).node.successfulOutput).toBe("candidate");
      expect(existsSync(validatorLaunch)).toBe(true);
      expect(existsSync(successorLaunch)).toBe(true);
      const sections: LogsDto["sections"] = [];
      await streamServiceLogChunks(health.metadata.socketPath, "large-stderr", started.runId, (section) => { sections.push(section); });
      const diagnostic = sections.find((section) => section.kind === "capture" && section.label === "worker worker stderr");
      expect(diagnostic?.kind).toBe("capture");
      if (diagnostic?.kind !== "capture") throw new Error("worker stderr capture is missing");
      expect(diagnostic.capture.totalBytes).toBe(70_000);
      expect(diagnostic.capture.retainedBytes).toBe(1024);
      expect(diagnostic.capture.complete).toBe(false);
      const stdout = sections.find((section) => section.kind === "capture" && section.label === "worker worker stdout");
      expect(stdout?.kind).toBe("capture");
      if (stdout?.kind !== "capture") throw new Error("worker stdout capture is missing");
      expect(stdout.content).toContain("<status>succeeded</status>");
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("streams a valid 18 MiB capture through bounded, UTF-8-safe fragments", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-large-log-section-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const outputBytes = 18 * 1024 * 1024;
    const exactPrefix = "\uFEFFλ\r\n\u0001";
    const beforeBoundaryCodePoint = 512 * 1024 - new TextEncoder().encode(exactPrefix).byteLength - 1;
    mkdirSync(workflows, { recursive: true });
    const harnessCommand = String.raw`printf '<status>succeeded</status>\n<output>candidate</output>'
{
  printf '\357\273\277\316\273\r\n\001'
  head -c ${beforeBoundaryCodePoint} /dev/zero | tr '\000' x
  printf '\342\202\254'
  head -c 18874368 /dev/zero | tr '\000' x
} >&2`;
    writeFileSync(join(config, "workshop.yaml"), `shell: /bin/sh\nkeep_files: always\nstream_cap: unlimited\nagent:\n  model: fixture/mock-model:medium\n  harness:\n    command: |\n${harnessCommand.split("\n").map((line) => `      ${line}`).join("\n")}\n`, "utf8");
    writeFileSync(join(workflows, "large-capture.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - large:",
      "      agent: Return the fixture result.",
      "",
    ].join("\n"), "utf8");
    const installation = loadInstallation(root);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(installation);
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const startedResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "start", requestId: "large-capture-start", workflowId: "large-capture",
      });
      if (!startedResponse.ok) throw new Error(startedResponse.error.message);
      const started = serviceStartResultV1Schema.parse(startedResponse.result);
      await waitForCompletedRun(health.metadata.socketPath, "large-capture", started.runId);
      const chunks: string[] = [];
      const chunkBytes: number[] = [];
      await streamServiceLogChunks(health.metadata.socketPath, "large-capture", started.runId, (section) => {
        if (section.kind === "capture" && section.label === "large worker stderr" && section.content !== null) {
          chunks.push(section.content);
          chunkBytes.push(new TextEncoder().encode(section.content).byteLength);
        }
      }, 30_000);
      const reconstructed = chunks.join("");
      expect(chunkBytes.length).toBeGreaterThan(1);
      expect(chunkBytes[0]).toBe(512 * 1024 - 1);
      expect(chunks[1]?.startsWith("€")).toBe(true);
      expect(Math.max(...chunkBytes)).toBeLessThanOrEqual(512 * 1024);
      expect(new TextEncoder().encode(reconstructed).byteLength).toBe(outputBytes + beforeBoundaryCodePoint + 3 + new TextEncoder().encode(exactPrefix).byteLength);
      expect(reconstructed).toBe(`${exactPrefix}${"x".repeat(beforeBoundaryCodePoint)}€${"x".repeat(outputBytes)}`);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("streams compact and verbose worklogs through bounded pages", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-large-worklog-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const summaryBytes = 60_000;
    const nodeIds = Array.from({ length: 18 }, (_, index) => `node-${String(index).padStart(2, "0")}`);
    mkdirSync(workflows, { recursive: true });
    const harnessCommand = String.raw`summary=$(head -c 60000 /dev/zero | tr '\000' y)
printf '<status>succeeded</status>\n<reason>%s</reason>\n<output>candidate</output>' "$summary"`;
    writeFileSync(join(config, "workshop.yaml"), `shell: /bin/sh\nagent:\n  model: fixture/mock-model:medium\n  harness:\n    command: |\n${harnessCommand.split("\n").map((line) => `      ${line}`).join("\n")}\n`, "utf8");
    const stepLines = nodeIds.flatMap((nodeId) => [
      `  - ${nodeId}:`,
      "      agent: Return the fixture result.",
    ]);
    writeFileSync(join(workflows, "large-worklog.yaml"), ["version: 4", "defaults: { retries: 0, replay: never }", "steps:", ...stepLines, ""].join("\n"), "utf8");
    const installation = loadInstallation(root);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(installation);
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const startedResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "start", requestId: "large-worklog-start", workflowId: "large-worklog",
      });
      if (!startedResponse.ok) throw new Error(startedResponse.error.message);
      const started = serviceStartResultV1Schema.parse(startedResponse.result);
      await waitForCompletedRun(health.metadata.socketPath, "large-worklog", started.runId);

      const compact = await readServiceWorklog(health.metadata.socketPath, "large-worklog", started.runId, 30_000);
      expect(compact).toContain("- node-00 #1 succeeded");
      expect(compact).not.toContain("y".repeat(1_000));
      const verbose = await readServiceWorklog(health.metadata.socketPath, "large-worklog", started.runId, 30_000, true);
      expect(new TextEncoder().encode(verbose).byteLength).toBeGreaterThan(1024 * 1024);
      expect(verbose).toContain(`> ${"y".repeat(summaryBytes)}`);

      const firstResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "logs.page", workflowId: "large-worklog", runId: started.runId, verbose: true,
      });
      if (!firstResponse.ok) throw new Error(firstResponse.error.message);
      const firstPage = serviceLogSectionPageV1Schema.parse(firstResponse.result);
      expect(firstPage.section.kind).toBe("worklog");
      expect(firstPage.chunk.complete).toBe(false);
      expect(firstPage.chunk.totalBytes).toBeGreaterThan(1024 * 1024);
      if (firstPage.nextCursor === null) throw new Error("large worklog has no continuation");
      const nextResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "logs.page", workflowId: "large-worklog", runId: started.runId, cursor: firstPage.nextCursor,
      });
      if (!nextResponse.ok) throw new Error(nextResponse.error.message);
      expect(serviceLogSectionPageV1Schema.parse(nextResponse.result).chunk.offsetBytes).toBe(firstPage.chunk.offsetBytes + new TextEncoder().encode(firstPage.section.content ?? "").byteLength);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);



  test("keeps an existing log continuation through live workflow progression", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-log-progression-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const releaseFirst = join(root, "release-first");
    const releaseSecond = join(root, "release-second");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\nkeep_files: always\n", "utf8");
    writeFileSync(join(workflows, "progress.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - first:",
      `      run: 'while [ ! -e "${releaseFirst}" ]; do sleep 0.01; done; printf first'`,
      "  - second:",
      `      run: 'while [ ! -e "${releaseSecond}" ]; do sleep 0.01; done; printf second'`,
      "",
    ].join("\n"), "utf8");
    const installation = loadInstallation(root);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(installation);
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const socketPath = health.metadata.socketPath;
      const startedResponse = await sendServiceRequest(socketPath, {
        version: 1, method: "start", requestId: "progress-start", workflowId: "progress",
      });
      if (!startedResponse.ok) throw new Error(startedResponse.error.message);
      const started = serviceStartResultV1Schema.parse(startedResponse.result);
      writeFileSync(releaseFirst, "");
      const deadline = Date.now() + 10_000;
      let firstSnapshot: ReturnType<typeof serviceLogSectionPageV1Schema.parse> | undefined;
      while (Date.now() < deadline) {
        const response = await sendServiceRequest(socketPath, { version: 1, method: "logs.page", workflowId: "progress", runId: started.runId });
        if (!response.ok) throw new Error(response.error.message);
        const page = serviceLogSectionPageV1Schema.parse(response.result);
        if (page.totalSections === 2) { firstSnapshot = page; break; }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      if (firstSnapshot === undefined || firstSnapshot.nextCursor === null) throw new Error("first process capture snapshot was not available");
      writeFileSync(releaseSecond, "");
      await waitForCompletedRun(socketPath, "progress", started.runId);
      let cursor: string | undefined = firstSnapshot.nextCursor;
      const continued = [];
      for (const expectedIndex of [1]) {
        if (cursor === undefined) throw new Error("initial log snapshot ended before its captured sections");
        const response = await sendServiceRequest(socketPath, {
          version: 1, method: "logs.page", workflowId: "progress", runId: started.runId, cursor,
        });
        if (!response.ok) throw new Error(response.error.message);
        const page = serviceLogSectionPageV1Schema.parse(response.result);
        expect(page.totalSections).toBe(2);
        expect(page.sectionIndex).toBe(expectedIndex);
        continued.push(page.section);
        cursor = page.nextCursor ?? undefined;
      }
      expect(cursor).toBeUndefined();
      expect(continued.map((section) => section.label)).toEqual(["first worker stdout"]);
      const freshResponse = await sendServiceRequest(socketPath, { version: 1, method: "logs.page", workflowId: "progress", runId: started.runId });
      if (!freshResponse.ok) throw new Error(freshResponse.error.message);
      expect(serviceLogSectionPageV1Schema.parse(freshResponse.result).totalSections).toBe(3);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("uses Durable process order for late evidence and keeps each in-memory log snapshot consistent", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-retained-log-reopen-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    mkdirSync(workflows, { recursive: true });
    const harnessCommand = String.raw`printf '<status>succeeded</status>\n<output>candidate</output>'
head -c 12000 /dev/zero | tr '\000' r >&2`;
    writeFileSync(join(config, "workshop.yaml"), `shell: /bin/sh\nkeep_files: always\nstream_cap: 1kb\nagent:\n  model: fixture/mock-model:medium\n  harness:\n    command: |\n${harnessCommand.split("\n").map((line) => `      ${line}`).join("\n")}\n`, "utf8");
    writeFileSync(join(workflows, "retained.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - capture:",
      "      agent: Return the fixture result.",
      "",
    ].join("\n"), "utf8");
    const installation = loadInstallation(root);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(installation);
      let health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const socketPath = health.metadata.socketPath;
      const startedResponse = await sendServiceRequest(socketPath, {
        version: 1, method: "start", requestId: "retained-start", workflowId: "retained",
      });
      if (!startedResponse.ok) throw new Error(startedResponse.error.message);
      const started = serviceStartResultV1Schema.parse(startedResponse.result);
      await waitForCompletedRun(socketPath, "retained", started.runId);
      const firstResponse = await sendServiceRequest(socketPath, { version: 1, method: "logs.page", workflowId: "retained", runId: started.runId });
      if (!firstResponse.ok) throw new Error(firstResponse.error.message);
      const first = serviceLogSectionPageV1Schema.parse(firstResponse.result);
      if (first.nextCursor === null) throw new Error("retained log snapshot has no capture continuation");
      await owner.shutdown();
      owner = undefined;
      const reopenedStorage = await openDurableStorage(installation.databasePath);
      if (!reopenedStorage.ok) throw new Error(reopenedStorage.failure.message);
      const auditHarness = await Harness.open(reopenedStorage.storage, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
      try {
        const installationDocument = installationDocumentV1Schema.safeParse(
          await auditHarness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT),
        );
        if (!installationDocument.success || installationDocument.data.state !== "ready") {
          throw new Error("reopened installation document is unavailable");
        }
        const reference = installationDocument.data.workflows.retained?.runs.find((run) => run.runId === started.runId);
        if (reference === undefined) throw new Error("retained run reference is missing");
        // SAFETY: the checked installation index stores a positive Durable conversation ID.
        const conversationId = reference.conversationId as ConversationId;
        const conversation = await auditHarness.conversation(conversationId, BACKGROUND_CONTEXT);
        if (conversation === undefined) throw new Error("retained run conversation is unavailable");
        const entries = await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT);
        const processEntry = entries.items.find((entry) => WorkshopProcessEntry.is(entry));
        if (processEntry === undefined) throw new Error("retained process evidence is missing");
        const processEvidence = workshopProcessV1Schema.parse(processEntry.data);
        const lateEvidence = workshopProcessV1Schema.parse({
          ...processEvidence,
          recordedAt: "2000-01-01T00:00:00.000Z",
          process: {
            ...processEvidence.process,
            captures: processEvidence.process.captures.map((capture) => ({
              ...capture, totalBytes: capture.totalBytes + 1, truncatedBytes: capture.truncatedBytes + 1, complete: false,
            })),
          },
        });
        await auditHarness.commit(async (tx) => {
          await tx.appendEntry(WorkshopProcessEntry, conversationId, { data: lateEvidence });
        }, BACKGROUND_CONTEXT);
      } finally {
        await auditHarness.close(BACKGROUND_CONTEXT);
      }
      owner = await startWorkshopService(installation);
      health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const freshResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "logs.page", workflowId: "retained", runId: started.runId,
      });
      if (!freshResponse.ok) throw new Error(freshResponse.error.message);
      const freshPage = serviceLogSectionPageV1Schema.parse(freshResponse.result);
      if (freshPage.nextCursor === null) throw new Error("fresh retained log snapshot has no capture continuation");
      const captureAfter = async (cursor: string) => {
        let currentCursor: string | null = cursor;
        while (currentCursor !== null) {
          const response = await sendServiceRequest(health.metadata.socketPath, {
            version: 1, method: "logs.page", workflowId: "retained", runId: started.runId, cursor: currentCursor,
          });
          if (!response.ok) throw new Error(response.error.message);
          const page = serviceLogSectionPageV1Schema.parse(response.result);
          if (page.section.kind === "capture" && page.section.label === "capture worker stderr") return page.section;
          currentCursor = page.nextCursor;
        }
        throw new Error("worker stderr capture is missing from the log snapshot");
      };
      const freshCapture = await captureAfter(freshPage.nextCursor);
      expect(freshCapture.capture.totalBytes).toBe(12_001);
      const continuedCapture = await captureAfter(first.nextCursor);
      expect(continuedCapture.capture.totalBytes).toBe(12_000);
      expect(continuedCapture.capture.retainedBytes).toBe(1024);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);




async function startCompletedRun(socketPath: string, requestId: string) {
  const startedResponse = await sendServiceRequest(socketPath, { version: 1, method: "start", requestId, workflowId: "clock" });
  if (!startedResponse.ok) throw new Error(startedResponse.error.message);
  const started = serviceStartResultV1Schema.parse(startedResponse.result);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await sendServiceRequest(socketPath, { version: 1, method: "runs", workflowId: "clock", limit: 1 });
    if (!response.ok) throw new Error(response.error.message);
    const page = serviceRunsPageV1Schema.parse(response.result);
    const run = page.runs.find((candidate) => candidate.runId === started.runId);
    if (run?.status === "completed") return started;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`run ${started.runId} did not complete before the fixture deadline`);
}
});
