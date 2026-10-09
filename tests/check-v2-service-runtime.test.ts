import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { loadV2Installation, loadCheckedV2Workflow } from "../src/installation/load-v2-installation.js";
import { installationDocumentV1Schema } from "../src/installation/schema-v2.js";
import { workshopProcessV1Schema } from "../src/run/records-v2.js";
import { serviceLogSectionPageV1Schema, serviceRunsPageV1Schema, serviceStartResultV1Schema } from "../src/service/schema.js";
import { probeServiceHealth } from "../src/service/probe-service-health.js";
import { readServiceWorklog, sendServiceRequest, streamServiceLogChunks, streamServiceLogSections } from "../src/service/send-service-request.js";
import { acquireServiceLock } from "../src/service/acquire-service-lock.js";
import { WorkshopInstallationDoc, WorkshopProcessEntry } from "../src/storage/durable/define-workshop-records.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import { startV2WorkshopService } from "../src/service/open-v2-service-runtime.js";
import { logsDtoV2Schema, nodeDescriptionDtoV2Schema, statusDtoV2Schema, type LogsDtoV2 } from "../src/views/schema-v2.js";

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


describe("v4 Durable service runtime", () => {
  test("serves start, status, runs, and logs for one canonical run through real SQLite and Harness resources", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-v4-service-runtime-"));
    const config = join(root, ".workshop", "config");
    const workflows = join(config, "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "version: 2\nshell: /bin/bash\n", "utf8");
    writeFileSync(join(workflows, "clock.yaml"), [
      "version: 2",
      "id: clock",
      "description: Durable service fixture",
      "nodes:",
      "  tick:",
      "    run:",
      "      command: sleep 0.3; printf 'fixture-output'",
      "    next: null",
      "",
    ].join("\n"), "utf8");

    const installation = loadV2Installation(root);
    const checked = loadCheckedV2Workflow(installation, "clock");
    let owner: Awaited<ReturnType<typeof startV2WorkshopService>> | undefined;
    try {
      owner = await startV2WorkshopService(installation);
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
      const activeStatus = statusDtoV2Schema.parse(during.result);
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

      const logSections: LogsDtoV2["sections"] = [];
      const logStream = await streamServiceLogSections(socketPath, "clock", started.runId, (section) => { logSections.push(section); });
      const logs = logsDtoV2Schema.parse({ version: 2, runId: logStream.runId, sections: logSections, projection: logStream.projection });
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
      const finalStatus = statusDtoV2Schema.parse(after.result);
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
    const root = mkdtempSync(join(tmpdir(), "workshop-v4-judgment-repair-"));
    const config = join(root, ".workshop", "config");
    const workflows = join(config, "workflows");
    const workerLaunches = join(root, "worker-launches.txt");
    const validatorLaunches = join(root, "validator-launches.txt");
    const validatorFirstFailure = join(root, "validator-first-failure.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "version: 2\nshell: /bin/bash\n", "utf8");
    writeFileSync(join(workflows, "judgment-repair.yaml"), [
      "version: 2",
      "id: judgment-repair",
      "nodes:",
      "  verify:",
      "    replay: safe",
      "    max_attempts: 2",
      "    run:",
      `      command: >-\n        printf w >> '${workerLaunches}'; printf candidate`,
      "    validator:",
      "      replay: safe",
      `      command: >-\n        printf v >> '${validatorLaunches}'; if [ ! -e '${validatorFirstFailure}' ]; then touch '${validatorFirstFailure}'; exit 7; fi; exit 0`,
      "    next: null",
      "orchestrator:",
      "  model: faux/failure-judge:low",
      "  timeout: 20s",
      "",
    ].join("\n"), "utf8");
    const installation = loadV2Installation(root);
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
    let owner: Awaited<ReturnType<typeof startV2WorkshopService>> | undefined;
    const count = (path: string) => existsSync(path) ? readFileSync(path, "utf8").length : 0;
    try {
      owner = await startV2WorkshopService(installation, { models });
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const socketPath = health.metadata.socketPath;
      const started = await sendServiceRequest(socketPath, { version: 1, method: "start", requestId: "judgment-repair-start", workflowId: "judgment-repair" });
      if (!started.ok) throw new Error(started.error.message);
      const startResult = serviceStartResultV1Schema.parse(started.result);
      let blocked: ReturnType<typeof statusDtoV2Schema.parse> | undefined;
      const blockDeadline = Date.now() + 10_000;
      while (Date.now() < blockDeadline) {
        const response = await sendServiceRequest(socketPath, { version: 1, method: "status", workflowId: "judgment-repair" });
        if (!response.ok) throw new Error(response.error.message);
        const status = statusDtoV2Schema.parse(response.result);
        if (status.workflows[0]?.unresolvedRun?.status === "blocked") { blocked = status; break; }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      if (blocked === undefined) throw new Error("workflow did not block on the unavailable native judge");
      expect(blocked.workflows[0]?.unresolvedRun?.block?.kind).toBe("orchestrator_unavailable");
      expect(count(workerLaunches)).toBe(1);
      expect(count(validatorLaunches)).toBe(1);
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
      const nodeBeforeDecision = nodeDescriptionDtoV2Schema.parse(duringJudge.result).node;
      expect(nodeBeforeDecision.attempts).toHaveLength(1);
      expect(nodeBeforeDecision.attempts[0]?.number).toBe(1);
      expect(nodeBeforeDecision.attempts[0]?.status).toBe("failed");
      expect(count(workerLaunches)).toBe(1);
      expect(count(validatorLaunches)).toBe(1);
      releaseDecision();
      let finalNode: ReturnType<typeof nodeDescriptionDtoV2Schema.parse> | undefined;
      const retryDeadline = Date.now() + 10_000;
      while (Date.now() < retryDeadline) {
        const response = await sendServiceRequest(socketPath, { version: 1, method: "node.describe", workflowId: "judgment-repair", runId: startResult.runId, nodeId: "verify" });
        if (!response.ok) throw new Error(response.error.message);
        finalNode = nodeDescriptionDtoV2Schema.parse(response.result);
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
  test("preserves BOMs, isolates invalid UTF-8, and reports a missing capture locally", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-v4-log-text-integrity-"));
    const config = join(root, ".workshop", "config");
    const workflows = join(config, "workflows");
    mkdirSync(workflows, { recursive: true });
    const harnessCommand = String.raw`printf '%s' '{"version":1,"output":"candidate","summary":"fixture result","artifacts":[]}' > "$WORKSHOP_RESULT_FILE"
case "$WORKSHOP_NODE_ID" in
  bom) printf '\357\273\277raw-bom' ;;
  invalid) printf '\377raw-invalid' ;;
  readable) printf 'other sections remain readable' ;;
esac`;
    writeFileSync(join(config, "workshop.yaml"), `version: 2\nshell: /bin/bash\nagent:\n  model: fixture/mock-model:medium\n  harness:\n    command: |\n${harnessCommand.split("\n").map((line) => `      ${line}`).join("\n")}\n`, "utf8");
    writeFileSync(join(workflows, "capture-text.yaml"), [
      "version: 2",
      "id: capture-text",
      "nodes:",
      "  bom:",
      "    run:",
      "      agent:",
      "        instructions: Return the fixture result.",
      "    next: invalid",
      "  invalid:",
      "    run:",
      "      agent:",
      "        instructions: Return the fixture result.",
      "    next: readable",
      "  readable:",
      "    run:",
      "      agent:",
      "        instructions: Return the fixture result.",
      "    next: null",
      "",
    ].join("\n"), "utf8");
    const installation = loadV2Installation(root);
    let owner: Awaited<ReturnType<typeof startV2WorkshopService>> | undefined;
    try {
      owner = await startV2WorkshopService(installation);
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const startedResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "start", requestId: "capture-text-start", workflowId: "capture-text",
      });
      if (!startedResponse.ok) throw new Error(startedResponse.error.message);
      const started = serviceStartResultV1Schema.parse(startedResponse.result);
      await waitForCompletedRun(health.metadata.socketPath, "capture-text", started.runId);
      const logSections: LogsDtoV2["sections"] = [];
      const logStream = await streamServiceLogSections(health.metadata.socketPath, "capture-text", started.runId, (section) => { logSections.push(section); });
      const logs = logsDtoV2Schema.parse({ version: 2, runId: logStream.runId, sections: logSections, projection: logStream.projection });
      const bom = logs.sections.find((section) => section.kind === "capture" && section.label === "bom worker stdout");
      const invalid = logs.sections.find((section) => section.kind === "capture" && section.label === "invalid worker stdout");
      const readable = logs.sections.find((section) => section.kind === "capture" && section.label === "readable worker stdout");
      expect(bom?.kind).toBe("capture");
      if (bom?.kind !== "capture") throw new Error("BOM capture section is missing");
      expect(bom.content).toBe("\uFEFFraw-bom");
      expect(invalid?.kind).toBe("capture");
      if (invalid?.kind !== "capture") throw new Error("invalid UTF-8 capture section is missing");
      expect(invalid.content).toBeNull();
      expect(invalid.unavailableReason).toBe("capture contains invalid UTF-8");
      expect(readable?.kind).toBe("capture");
      if (readable?.kind !== "capture") throw new Error("readable capture section is missing");
      expect(readable.content).toBe("other sections remain readable");
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
      expect(pages.find((section) => section.kind === "capture" && section.label === "invalid worker stdout")?.content).toBeNull();

      rmSync(readable.capture.path);
      const missingSections: LogsDtoV2["sections"] = [];
      const missingStream = await streamServiceLogSections(health.metadata.socketPath, "capture-text", started.runId, (section) => { missingSections.push(section); });
      const missingLogs = logsDtoV2Schema.parse({ version: 2, runId: missingStream.runId, sections: missingSections, projection: missingStream.projection });
      const missing = missingLogs.sections.find((section) => section.kind === "capture" && section.label === "readable worker stdout");
      expect(missing?.kind).toBe("capture");
      if (missing?.kind !== "capture") throw new Error("missing capture section is missing");
      expect(missing.content).toBeNull();
      expect(missing.unavailableReason).toBe("capture file is missing");
      if (missing.unavailableReason === null) throw new Error("missing capture section has no diagnostic");
      expect(missing.unavailableReason.length).toBeLessThanOrEqual(64 * 1024);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("bounds artifact_missing diagnostics without truncating worker artifact metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-v4-long-artifact-path-"));
    const config = join(root, ".workshop", "config");
    const workflows = join(config, "workflows");
    const validatorLaunch = join(root, "validator-launched");
    const successorLaunch = join(root, "successor-launched");
    const artifactPath = `/${"a".repeat(70_000)}`;
    const harnessScript = join(root, "write-result.sh");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(harnessScript, `printf '%s' '${JSON.stringify({ version: 1, output: "candidate", summary: "long-path fixture", artifacts: [{ kind: "report", path: artifactPath }] })}' > "$WORKSHOP_RESULT_FILE"\n`, "utf8");
    writeFileSync(join(config, "workshop.yaml"), [
      "version: 2",
      "shell: /bin/bash",
      "agent:",
      "  model: fixture/mock-model:medium",
      "  harness:",
      "    command: >-",
      `      bash ${JSON.stringify(harnessScript)}`,
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "long-artifact.yaml"), [
      "version: 2",
      "id: long-artifact",
      "nodes:",
      "  worker:",
      "    run:",
      "      agent:",
      "        instructions: Return the fixture result.",
      "    validator:",
      `      command: 'printf launched > ${validatorLaunch}'`,
      "    next: successor",
      "  successor:",
      "    run:",
      `      command: 'printf launched > ${successorLaunch}'`,
      "    next: null",
      "",
    ].join("\n"), "utf8");
    const installation = loadV2Installation(root);
    let owner: Awaited<ReturnType<typeof startV2WorkshopService>> | undefined;
    try {
      owner = await startV2WorkshopService(installation);
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const startedResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "start", requestId: "long-artifact-start", workflowId: "long-artifact",
      });
      if (!startedResponse.ok) throw new Error(startedResponse.error.message);
      const started = serviceStartResultV1Schema.parse(startedResponse.result);
      const deadline = Date.now() + 15_000;
      let run: ReturnType<typeof serviceRunsPageV1Schema.parse>["runs"][number] | undefined;
      while (Date.now() < deadline) {
        const response = await sendServiceRequest(health.metadata.socketPath, { version: 1, method: "runs", workflowId: "long-artifact", limit: 10 });
        if (!response.ok) throw new Error(response.error.message);
        const page = serviceRunsPageV1Schema.parse(response.result);
        run = page.runs.find((candidate) => candidate.runId === started.runId);
        if (run !== undefined && ["failed", "completed", "blocked", "cancelled"].includes(run.status)) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      if (run?.status !== "failed") throw new Error(`long-path run did not fail as expected: ${run?.status ?? "missing"}`);
      expect(run.failure?.kind).toBe("artifact_missing");
      if (run.failure?.kind !== "artifact_missing") throw new Error("run failure is not the missing-artifact diagnostic");
      expect(run.failure.message.length).toBeLessThanOrEqual(64 * 1024);
      expect(run.failure.message).toContain("sha256:");
      expect(existsSync(validatorLaunch)).toBe(false);
      expect(existsSync(successorLaunch)).toBe(false);

      const descriptionResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "node.describe", workflowId: "long-artifact", nodeId: "worker", runId: started.runId,
      });
      if (!descriptionResponse.ok) throw new Error(descriptionResponse.error.message);
      const description = nodeDescriptionDtoV2Schema.parse(descriptionResponse.result);
      expect(description.node.status).toBe("failed");
      expect(description.node.successfulOutput).toBeNull();
      const successorResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "node.describe", workflowId: "long-artifact", nodeId: "successor", runId: started.runId,
      });
      if (!successorResponse.ok) throw new Error(successorResponse.error.message);
      expect(nodeDescriptionDtoV2Schema.parse(successorResponse.result).node.status).toBe("pending");
      const worklog = await readServiceWorklog(health.metadata.socketPath, "long-artifact", started.runId);
      expect(worklog).toContain(`> ${artifactPath}`);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);


  test("streams a valid 18 MiB capture through bounded, UTF-8-safe fragments", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-v4-large-log-section-"));
    const config = join(root, ".workshop", "config");
    const workflows = join(config, "workflows");
    const outputBytes = 18 * 1024 * 1024;
    const exactPrefix = "\uFEFFλ\r\n\u0001";
    const beforeBoundaryCodePoint = 512 * 1024 - new TextEncoder().encode(exactPrefix).byteLength - 1;
    mkdirSync(workflows, { recursive: true });
    const harnessCommand = String.raw`printf '%s' '{"version":1,"output":"candidate","summary":"large capture fixture","artifacts":[]}' > "$WORKSHOP_RESULT_FILE"
printf '\357\273\277\316\273\r\n\001'
head -c ${beforeBoundaryCodePoint} /dev/zero | tr '\000' x
printf '\342\202\254'
head -c 18874368 /dev/zero | tr '\000' x`;
    writeFileSync(join(config, "workshop.yaml"), `version: 2\nshell: /bin/bash\nstream_cap: unlimited\nagent:\n  model: fixture/mock-model:medium\n  harness:\n    command: |\n${harnessCommand.split("\n").map((line) => `      ${line}`).join("\n")}\n`, "utf8");
    writeFileSync(join(workflows, "large-capture.yaml"), [
      "version: 2",
      "id: large-capture",
      "nodes:",
      "  large:",
      "    run:",
      "      agent:",
      "        instructions: Return the fixture result.",
      "    next: null",
      "",
    ].join("\n"), "utf8");
    const installation = loadV2Installation(root);
    let owner: Awaited<ReturnType<typeof startV2WorkshopService>> | undefined;
    try {
      owner = await startV2WorkshopService(installation);
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
        if (section.kind === "capture" && section.label === "large worker stdout" && section.content !== null) {
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

  test("streams an unbounded worklog in bounded chunks and rejects missing or tampered snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-v4-large-worklog-"));
    const config = join(root, ".workshop", "config");
    const workflows = join(config, "workflows");
    const summaryBytes = 60_000;
    const nodeIds = Array.from({ length: 18 }, (_, index) => `node-${String(index).padStart(2, "0")}`);
    mkdirSync(workflows, { recursive: true });
    const harnessCommand = String.raw`summary=$(head -c 60000 /dev/zero | tr '\000' y)
printf '{"version":1,"output":"candidate","summary":"%s","artifacts":[]}' "$summary" > "$WORKSHOP_RESULT_FILE"`;
    writeFileSync(join(config, "workshop.yaml"), `version: 2\nshell: /bin/bash\nagent:\n  model: fixture/mock-model:medium\n  harness:\n    command: |\n${harnessCommand.split("\n").map((line) => `      ${line}`).join("\n")}\n`, "utf8");
    const nodeLines = nodeIds.flatMap((nodeId, index) => [
      `  ${nodeId}:`,
      "    run:",
      "      agent:",
      "        instructions: Return the fixture result.",
      `    next: ${nodeIds[index + 1] ?? "null"}`,
    ]);
    writeFileSync(join(workflows, "large-worklog.yaml"), ["version: 2", "id: large-worklog", "nodes:", ...nodeLines, ""].join("\n"), "utf8");
    const installation = loadV2Installation(root);
    let owner: Awaited<ReturnType<typeof startV2WorkshopService>> | undefined;
    try {
      owner = await startV2WorkshopService(installation);
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const startedResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "start", requestId: "large-worklog-start", workflowId: "large-worklog",
      });
      if (!startedResponse.ok) throw new Error(startedResponse.error.message);
      const started = serviceStartResultV1Schema.parse(startedResponse.result);
      await waitForCompletedRun(health.metadata.socketPath, "large-worklog", started.runId);
      const worklog = await readServiceWorklog(health.metadata.socketPath, "large-worklog", started.runId, 30_000);
      expect(new TextEncoder().encode(worklog).byteLength).toBeGreaterThan(1024 * 1024);
      expect(worklog).toContain(`> ${"y".repeat(summaryBytes)}`);

      const firstResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "logs.page", workflowId: "large-worklog", runId: started.runId,
      });
      if (!firstResponse.ok) throw new Error(firstResponse.error.message);
      const firstPage = serviceLogSectionPageV1Schema.parse(firstResponse.result);
      expect(firstPage.section.kind).toBe("worklog");
      expect(firstPage.chunk.complete).toBe(false);
      expect(firstPage.chunk.totalBytes).toBeGreaterThan(1024 * 1024);
      if (firstPage.nextCursor === null) throw new Error("large worklog has no continuation");
      const cursorData = JSON.parse(Buffer.from(firstPage.nextCursor, "base64url").toString("utf8")) as { contentHash: string };
      const snapshotPath = join(installation.runsDirectory, started.runId, "captures", ".log-snapshots", `worklog-${cursorData.contentHash.slice("sha256:".length)}.utf8`);
      writeFileSync(snapshotPath, "z".repeat(firstPage.chunk.totalBytes), "utf8");
      const tamperedResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "logs.page", workflowId: "large-worklog", runId: started.runId, cursor: firstPage.nextCursor,
      });
      expect(tamperedResponse.ok).toBe(false);

      const repairedResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "logs.page", workflowId: "large-worklog", runId: started.runId,
      });
      if (!repairedResponse.ok) throw new Error(repairedResponse.error.message);
      const repairedPage = serviceLogSectionPageV1Schema.parse(repairedResponse.result);
      if (repairedPage.nextCursor === null) throw new Error("repaired worklog has no continuation");
      const repairedCursor = JSON.parse(Buffer.from(repairedPage.nextCursor, "base64url").toString("utf8")) as { contentHash: string };
      const repairedSnapshotPath = join(installation.runsDirectory, started.runId, "captures", ".log-snapshots", `worklog-${repairedCursor.contentHash.slice("sha256:".length)}.utf8`);
      rmSync(repairedSnapshotPath);
      const missingResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "logs.page", workflowId: "large-worklog", runId: started.runId, cursor: repairedPage.nextCursor,
      });
      expect(missingResponse.ok).toBe(false);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);


  test("keeps an existing log continuation through live workflow progression", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-v4-log-progression-"));
    const config = join(root, ".workshop", "config");
    const workflows = join(config, "workflows");
    const releaseFirst = join(root, "release-first");
    const releaseSecond = join(root, "release-second");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "version: 2\nshell: /bin/bash\n", "utf8");
    writeFileSync(join(workflows, "progress.yaml"), [
      "version: 2",
      "id: progress",
      "nodes:",
      "  first:",
      "    run:",
      `      command: 'while [ ! -e "${releaseFirst}" ]; do sleep 0.01; done; printf first'`,
      "    next: second",
      "  second:",
      "    run:",
      `      command: 'while [ ! -e "${releaseSecond}" ]; do sleep 0.01; done; printf second'`,
      "    next: null",
      "",
    ].join("\n"), "utf8");
    const installation = loadV2Installation(root);
    let owner: Awaited<ReturnType<typeof startV2WorkshopService>> | undefined;
    try {
      owner = await startV2WorkshopService(installation);
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
        if (page.totalSections === 3) { firstSnapshot = page; break; }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      if (firstSnapshot === undefined || firstSnapshot.nextCursor === null) throw new Error("first process capture snapshot was not available");
      writeFileSync(releaseSecond, "");
      await waitForCompletedRun(socketPath, "progress", started.runId);
      let cursor: string | undefined = firstSnapshot.nextCursor;
      const continued = [];
      for (const expectedIndex of [1, 2]) {
        if (cursor === undefined) throw new Error("initial log snapshot ended before its captured sections");
        const response = await sendServiceRequest(socketPath, {
          version: 1, method: "logs.page", workflowId: "progress", runId: started.runId, cursor,
        });
        if (!response.ok) throw new Error(response.error.message);
        const page = serviceLogSectionPageV1Schema.parse(response.result);
        expect(page.totalSections).toBe(3);
        expect(page.sectionIndex).toBe(expectedIndex);
        continued.push(page.section);
        cursor = page.nextCursor ?? undefined;
      }
      expect(cursor).toBeUndefined();
      expect(continued.map((section) => section.label)).toEqual(["first worker stdout", "first worker stderr"]);
      const freshResponse = await sendServiceRequest(socketPath, { version: 1, method: "logs.page", workflowId: "progress", runId: started.runId });
      if (!freshResponse.ok) throw new Error(freshResponse.error.message);
      expect(serviceLogSectionPageV1Schema.parse(freshResponse.result).totalSections).toBe(5);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("uses Durable process order for late evidence and preserves log cursors across reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-v4-retained-log-reopen-"));
    const config = join(root, ".workshop", "config");
    const workflows = join(config, "workflows");
    mkdirSync(workflows, { recursive: true });
    const harnessCommand = String.raw`printf '%s' '{"version":1,"output":"candidate","summary":"retention fixture","artifacts":[]}' > "$WORKSHOP_RESULT_FILE"
head -c 12000 /dev/zero | tr '\000' r`;
    writeFileSync(join(config, "workshop.yaml"), `version: 2\nshell: /bin/bash\nstream_cap: 1kb\nagent:\n  model: fixture/mock-model:medium\n  harness:\n    command: |\n${harnessCommand.split("\n").map((line) => `      ${line}`).join("\n")}\n`, "utf8");
    writeFileSync(join(workflows, "retained.yaml"), [
      "version: 2",
      "id: retained",
      "nodes:",
      "  capture:",
      "    run:",
      "      agent:",
      "        instructions: Return the fixture result.",
      "    next: null",
      "",
    ].join("\n"), "utf8");
    const installation = loadV2Installation(root);
    let owner: Awaited<ReturnType<typeof startV2WorkshopService>> | undefined;
    try {
      owner = await startV2WorkshopService(installation);
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
      owner = await startV2WorkshopService(installation);
      health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const freshResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "logs.page", workflowId: "retained", runId: started.runId,
      });
      if (!freshResponse.ok) throw new Error(freshResponse.error.message);
      const freshPage = serviceLogSectionPageV1Schema.parse(freshResponse.result);
      if (freshPage.nextCursor === null) throw new Error("fresh retained log snapshot has no capture continuation");
      const freshCaptureResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "logs.page", workflowId: "retained", runId: started.runId, cursor: freshPage.nextCursor,
      });
      if (!freshCaptureResponse.ok) throw new Error(freshCaptureResponse.error.message);
      const freshCapturePage = serviceLogSectionPageV1Schema.parse(freshCaptureResponse.result);
      expect(freshCapturePage.section.kind).toBe("capture");
      if (freshCapturePage.section.kind !== "capture") throw new Error("fresh retained capture is missing");
      expect(freshCapturePage.section.capture.totalBytes).toBe(12_001);
      const captureResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "logs.page", workflowId: "retained", runId: started.runId, cursor: first.nextCursor,
      });
      if (!captureResponse.ok) throw new Error(captureResponse.error.message);
      const capturePage = serviceLogSectionPageV1Schema.parse(captureResponse.result);
      expect(capturePage.sectionIndex).toBe(1);
      expect(capturePage.totalSections).toBe(3);
      expect(capturePage.section.kind).toBe("capture");
      if (capturePage.section.kind !== "capture") throw new Error("retained stream section is missing");
      expect(capturePage.section.capture).toMatchObject({
        totalBytes: 12_000, retainedBytes: 1024, truncatedBytes: 10_976, keptHeadBytes: 683, keptTailBytes: 341, complete: false,
      });
      expect(capturePage.section.content).toBe("r".repeat(1024));
      expect(capturePage.section.capture.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
      const receipt: unknown = JSON.parse(readFileSync(`${capturePage.section.capture.path}.retention.json`, "utf8"));
      expect(receipt).toMatchObject({
        version: 1, capBytes: 1024, totalBytes: 12_000, retainedBytes: 1024, truncatedBytes: 10_976,
        keptHeadBytes: 683, keptTailBytes: 341, retainedSha256: capturePage.section.capture.sha256,
      });
      expect(capturePage.nextCursor).not.toBeNull();
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
