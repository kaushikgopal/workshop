import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { loadInstallation, loadCheckedWorkflow } from "../src/installation/load-installation.js";
import { serviceLogSectionPageV1Schema, serviceRunsPageV1Schema, serviceStartResultV1Schema } from "../src/service/schema.js";
import { probeServiceHealth } from "../src/service/probe-service-health.js";
import { readServiceWorklog, sendServiceRequest, streamServiceLogChunks } from "../src/service/send-service-request.js";
import { acquireServiceLock } from "../src/service/acquire-service-lock.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import { startWorkshopService } from "../src/service/open-service-runtime.js";
import { checkBlockResolution } from "../src/run/check-block-resolution.js";
import { logsDtoSchema, nodeDescriptionDtoSchema, statusDtoSchema, type LogsDto } from "../src/views/schema.js";
import { createFauxModels } from "./fixtures/create-faux-models.js";

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
    expect(checkBlockResolution({ formatVersion: 4, blockKind: "runtime_incompatible", action: "retry" }))
      .toContain("permits only fail");
    expect(checkBlockResolution({ formatVersion: 4, blockKind: "integrity_failed", action: "retry" }))
      .toContain("permits only fail");
    expect(checkBlockResolution({ formatVersion: 4, blockKind: "integrity_failed", action: "accept" }))
      .toContain("permits only fail");
    expect(checkBlockResolution({ formatVersion: 4, blockKind: "runtime_incompatible", action: "fail" })).toBeNull();
    expect(checkBlockResolution({ formatVersion: 4, blockKind: "integrity_failed", action: "fail" })).toBeNull();
    expect(checkBlockResolution({ formatVersion: 3, blockKind: "runtime_incompatible", action: "retry" })).toBeNull();
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

  test("appends workflow sections and rebuilds them without repeating settled workers", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-stable-history-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\n");
    writeFileSync(join(workflows, "clock.yaml"), [
      "version: 4", "defaults: { retries: 0, replay: never }", "steps:",
      "  - tick: echo launch >> launches; printf fixture-output", "",
    ].join("\n"));
    const installation = loadInstallation(root);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(installation);
      const socketPath = owner.metadata.socketPath;
      const start = async (requestId: string) => {
        const response = await sendServiceRequest(socketPath, { version: 1, method: "start", workflowId: "clock", requestId });
        if (!response.ok) throw new Error(response.error.message);
        const run = serviceStartResultV1Schema.parse(response.result);
        await waitForCompletedRun(socketPath, "clock", run.runId);
        return run.runId;
      };
      const runId = await start("stable-history-1");
      const readStatus = async () => {
        const response = await sendServiceRequest(socketPath, { version: 1, method: "status" });
        if (!response.ok) throw new Error(response.error.message);
        return statusDtoSchema.parse(response.result);
      };
      await readStatus();
      const paths = ["results.md", "execution.log"].map(name => join(installation.workshopDirectory, "clock", name));
      const original = paths.map(path => ({ content: readFileSync(path, "utf8"), ino: statSync(path).ino }));
      await readStatus();
      await streamServiceLogChunks(socketPath, "clock", runId, () => {});
      await start("stable-history-2");
      await readStatus();
      const afterSecond = paths.map(path => readFileSync(path, "utf8"));
      expect(afterSecond[0]?.startsWith(original[0]?.content ?? "")).toBe(true);
      expect(afterSecond.map(text => (text.match(/<workshop-run id="/gu) ?? []).length)).toEqual([2, 2]);
      for (const path of paths) writeFileSync(path, "not committed state");
      await readStatus();
      expect(paths.map(path => (readFileSync(path, "utf8").match(/<workshop-run id="/gu) ?? []).length)).toEqual([2, 2]);
      for (const path of paths) rmSync(path);
      const status = await readStatus();
      expect(paths.map(path => (readFileSync(path, "utf8").match(/<workshop-run id="/gu) ?? []).length)).toEqual([2, 2]);
      expect(status.workflows[0]?.latestRun?.status).toBe("completed");
      expect(readFileSync(join(root, "launches"), "utf8")).toBe("launch\nlaunch\n");
      await owner.shutdown();
      owner = undefined;
      // Startup regenerates existing files too, without repeating settled workers.
      const resultsPath = paths[0];
      if (resultsPath === undefined) throw new Error("results path is missing");
      writeFileSync(resultsPath, "not committed state");
      owner = await startWorkshopService(installation);
      expect((readFileSync(resultsPath, "utf8").match(/<workshop-run id="/gu) ?? []).length).toBe(2);
      expect(readFileSync(join(root, "launches"), "utf8")).toBe("launch\nlaunch\n");
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps native final text and receipt evidence without process captures", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-native-final-text-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\nagent:\n  model: fixture/worker:medium\n");
    const outputs = ["\uFEFFraw-bom", "\uFFFDvalid-unicode", "other final assistant text"];
    writeFileSync(join(workflows, "native-text.yaml"), [
      "version: 4",
      "defaults: { retries: 0, replay: never }",
      "steps:",
      ...outputs.flatMap((_, index) => ["  - step-" + (index + 1) + ":", "      agent: Return the fixture result."]),
      "",
    ].join("\n"));
    const { models } = createFauxModels(outputs.map(output => fauxAssistantMessage(output)));
    const installation = loadInstallation(root);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(installation, models);
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const startedResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "start", requestId: "native-text-start", workflowId: "native-text",
      });
      if (!startedResponse.ok) throw new Error(startedResponse.error.message);
      const started = serviceStartResultV1Schema.parse(startedResponse.result);
      await waitForCompletedRun(health.metadata.socketPath, "native-text", started.runId);
      for (const [index, output] of outputs.entries()) {
        const descriptionResponse = await sendServiceRequest(health.metadata.socketPath, {
          version: 1, method: "node.describe", workflowId: "native-text", nodeId: "step-" + (index + 1), runId: started.runId,
        });
        if (!descriptionResponse.ok) throw new Error(descriptionResponse.error.message);
        const detail = nodeDescriptionDtoSchema.parse(descriptionResponse.result);
        expect(detail.node.successfulOutput).toBe(output);
        expect(detail.node.attempts[0]?.processes).toEqual([]);
        const evidence = JSON.stringify(detail);
        expect(evidence).toContain(output);
        expect(evidence).toContain(createHash("sha256").update(output).digest("hex"));
        expect(evidence).toContain("finalTextSha256");
        expect(evidence).toContain("conversationId");
        expect(evidence).toContain("assistantEntryId");
      }
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("keeps a large tagged final answer separate from command verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-large-agent-result-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const candidate = "x".repeat(70_000);
    const validatorLaunch = join(root, "validator-launched");
    const successorLaunch = join(root, "successor-launched");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\nkeep_files: always\nstream_cap: 1kb\nagent:\n  model: fixture/worker:medium\n");
    writeFileSync(join(workflows, "large-result.yaml"), [
      "version: 4",
      "defaults: { retries: 0, replay: never }",
      "steps:",
      "  - worker:",
      "      result: tagged",
      "      agent: Return the fixture result.",
      "      verify:",
      "        run: 'test \"$(wc -c)\" -eq 70000; printf launched > " + validatorLaunch + "'",
      "  - successor:",
      "      run: 'test \"$(wc -c)\" -eq 70000; printf launched > " + successorLaunch + "; printf completed'",
      "",
    ].join("\n"));
    const finalText = "<status>succeeded</status>\n<output>" + candidate + "</output>";
    const { models } = createFauxModels([fauxAssistantMessage(finalText)]);
    const installation = loadInstallation(root);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(installation, models);
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const startedResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "start", requestId: "large-agent-result", workflowId: "large-result",
      });
      if (!startedResponse.ok) throw new Error(startedResponse.error.message);
      const started = serviceStartResultV1Schema.parse(startedResponse.result);
      await waitForCompletedRun(health.metadata.socketPath, "large-result", started.runId);
      const descriptionResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "node.describe", workflowId: "large-result", nodeId: "worker", runId: started.runId,
      });
      if (!descriptionResponse.ok) throw new Error(descriptionResponse.error.message);
      const detail = nodeDescriptionDtoSchema.parse(descriptionResponse.result);
      expect(detail.node.successfulOutput).toBe(candidate);
      const candidateEvidence = detail.node.attempts[0]?.candidate;
      if (candidateEvidence?.kind !== "candidate") throw new Error("native candidate evidence is missing");
      expect(candidateEvidence.nativeExecution?.byteCount).toBe(new TextEncoder().encode(finalText).byteLength);
      expect(detail.node.attempts[0]?.processes.map((process) => process.role)).toEqual(["validator"]);
      expect(JSON.stringify(detail)).toContain("finalTextSha256");
      expect(JSON.stringify(detail)).toContain(createHash("sha256").update(finalText).digest("hex"));
      expect(existsSync(validatorLaunch)).toBe(true);
      expect(existsSync(successorLaunch)).toBe(true);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects oversized native final text with its hash receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-oversized-agent-result-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const verifierLaunch = join(root, "verifier-launched");
    const successorLaunch = join(root, "successor-launched");
    const finalText = "x".repeat(1024 * 1024 + 1);
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\nagent:\n  model: fixture/worker:medium\n");
    writeFileSync(join(workflows, "oversized.yaml"), [
      "version: 4",
      "defaults: { retries: 0, replay: never }",
      "steps:",
      "  - worker:",
      "      agent: Return an oversized fixture result.",
      "      verify: 'printf launched > " + verifierLaunch + "'",
      "  - successor:",
      "      run: 'printf launched > " + successorLaunch + "'",
      "",
    ].join("\n"));
    const { models } = createFauxModels([fauxAssistantMessage(finalText)]);
    const installation = loadInstallation(root);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(installation, models);
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const startedResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "start", requestId: "oversized-agent-result", workflowId: "oversized",
      });
      if (!startedResponse.ok) throw new Error(startedResponse.error.message);
      const started = serviceStartResultV1Schema.parse(startedResponse.result);
      const deadline = Date.now() + 15_000;
      let run: ReturnType<typeof serviceRunsPageV1Schema.parse>["runs"][number] | undefined;
      while (Date.now() < deadline) {
        const response = await sendServiceRequest(health.metadata.socketPath, { version: 1, method: "runs", workflowId: "oversized", limit: 10 });
        if (!response.ok) throw new Error(response.error.message);
        run = serviceRunsPageV1Schema.parse(response.result).runs.find(item => item.runId === started.runId);
        if (run?.status === "failed" || run?.status === "blocked") break;
        await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
      }
      expect(run?.status).toBe("failed");
      const descriptionResponse = await sendServiceRequest(health.metadata.socketPath, {
        version: 1, method: "node.describe", workflowId: "oversized", nodeId: "worker", runId: started.runId,
      });
      if (!descriptionResponse.ok) throw new Error(descriptionResponse.error.message);
      const detail = nodeDescriptionDtoSchema.parse(descriptionResponse.result);
      expect(detail.node.attempts[0]?.failure?.kind).toBe("result_too_large");
      expect(detail.node.attempts[0]?.processes).toEqual([]);
      const evidence = JSON.stringify(detail);
      expect(evidence).toContain("finalTextSha256");
      expect(evidence).toContain(createHash("sha256").update(finalText).digest("hex"));
      expect(detail.node.attempts[0]?.failure?.nativeExecution?.byteCount)
        .toBe(new TextEncoder().encode(finalText).byteLength);
      expect(existsSync(verifierLaunch)).toBe(false);
      expect(existsSync(successorLaunch)).toBe(false);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("streams compact and verbose worklogs through bounded pages", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-large-worklog-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const summaryBytes = 60_000;
    const nodeIds = Array.from({ length: 18 }, (_, index) => `node-${String(index).padStart(2, "0")}`);
    mkdirSync(workflows, { recursive: true });
    const summary = "y".repeat(summaryBytes);
    const finalText = "<status>succeeded</status>\n<reason>" + summary + "</reason>\n<output>candidate</output>";
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\nagent:\n  model: fixture/worker:medium\n", "utf8");
    const stepLines = nodeIds.flatMap((nodeId) => [
      `  - ${nodeId}:`,
      "      result: tagged",
      "      agent: Return the fixture result.",
    ]);
    writeFileSync(join(workflows, "large-worklog.yaml"), ["version: 4", "defaults: { retries: 0, replay: never }", "steps:", ...stepLines, ""].join("\n"), "utf8");
    const { models } = createFauxModels(nodeIds.map(() => fauxAssistantMessage(finalText)));
    const installation = loadInstallation(root);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(installation, models);
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

  test("retains native final-text receipts across a service reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-native-evidence-reopen-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const finalText = "r".repeat(12_000);
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\nagent:\n  model: fixture/worker:medium\n");
    writeFileSync(join(workflows, "retained.yaml"), [
      "version: 4",
      "defaults: { retries: 0, replay: never }",
      "steps:",
      "  - capture:",
      "      agent: Return the fixture result.",
      "",
    ].join("\n"));
    let requests = 0;
    const response: FauxResponseFactory = () => {
      requests += 1;
      return fauxAssistantMessage(finalText);
    };
    const { models } = createFauxModels([response]);
    const installation = loadInstallation(root);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(installation, models);
      const socketPath = owner.metadata.socketPath;
      if (socketPath === null) throw new Error("service socket path is missing");
      const startedResponse = await sendServiceRequest(socketPath, {
        version: 1, method: "start", requestId: "native-evidence-reopen", workflowId: "retained",
      });
      if (!startedResponse.ok) throw new Error(startedResponse.error.message);
      const started = serviceStartResultV1Schema.parse(startedResponse.result);
      await waitForCompletedRun(socketPath, "retained", started.runId);
      const beforeResponse = await sendServiceRequest(socketPath, {
        version: 1, method: "node.describe", workflowId: "retained", nodeId: "capture", runId: started.runId,
      });
      if (!beforeResponse.ok) throw new Error(beforeResponse.error.message);
      const before = nodeDescriptionDtoSchema.parse(beforeResponse.result);
      expect(before.node.successfulOutput).toBe(finalText);
      expect(before.node.attempts[0]?.processes).toEqual([]);
      expect(JSON.stringify(before)).toContain(createHash("sha256").update(finalText).digest("hex"));
      await owner.shutdown();
      owner = undefined;
      owner = await startWorkshopService(installation, models);
      const reopenedSocket = owner.metadata.socketPath;
      if (reopenedSocket === null) throw new Error("reopened service socket path is missing");
      const afterResponse = await sendServiceRequest(reopenedSocket, {
        version: 1, method: "node.describe", workflowId: "retained", nodeId: "capture", runId: started.runId,
      });
      if (!afterResponse.ok) throw new Error(afterResponse.error.message);
      const after = nodeDescriptionDtoSchema.parse(afterResponse.result);
      expect(after).toEqual(before);
      expect(JSON.stringify(after)).toContain("conversationId");
      expect(JSON.stringify(after)).toContain("assistantEntryId");
      expect(requests).toBe(1);
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

for (const terminalKind of ["failure", "early completion"] as const) {
  test(terminalKind + " releases capacity and the schedule admits the next occurrence", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-failure-schedule-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const marker = join(root, "failed-once");
    const successorMarker = join(root, "successor");
    const startedMarker = join(root, "started");
    const releaseMarker = join(root, "release");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\nmax_concurrent_runs: 1\n", "utf8");
    writeFileSync(join(workflows, "scheduled.yaml"), JSON.stringify({ version: 4, schedule: { every: "1s", max_runs: 2 }, defaults: { retries: 0, replay: "safe" },
      steps: [{ first: { result: terminalKind === "failure" ? "text" : "tagged", run:
        "if [ ! -e '" + marker + "' ]; then touch '" + startedMarker + "'; while [ ! -e '" + releaseMarker + "' ]; do sleep 0.02; done; touch '" + marker + "'; "
        + (terminalKind === "failure" ? "exit 9; " : "") + "fi; "
        + (terminalKind === "failure" ? "printf scheduled-success" : "printf '<status>success_and_complete</status>\\n<output>done</output>'") } },
        { later: "touch '" + successorMarker + "'; printf successor" }] }));
    writeFileSync(join(workflows, "queued.yaml"), JSON.stringify({ version: 4, defaults: { retries: 0, replay: "safe" }, steps: [{ first: "printf queued-success" }] }));
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(loadInstallation(root));
      const health = await probeServiceHealth(loadInstallation(root).stateDirectory);
      if (health.kind !== "ready") throw new Error("service unavailable");
      const socketPath = health.metadata.socketPath;
      const start = await sendServiceRequest(socketPath, { version: 1, method: "start", workflowId: "scheduled", requestId: "failure-schedule" });
      if (!start.ok) throw new Error(start.error.message);
      const firstRunId = serviceStartResultV1Schema.parse(start.result).runId;
      const deadline = Date.now() + 15_000;
      while (!existsSync(startedMarker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(startedMarker)).toBe(true);
      writeFileSync(releaseMarker, "go");
      for (;;) {
        const response = await sendServiceRequest(socketPath, { version: 1, method: "runs", workflowId: "scheduled" });
        if (!response.ok) throw new Error(response.error.message);
        if (serviceRunsPageV1Schema.parse(response.result).runs.find((run) => run.runId === firstRunId)?.status === (terminalKind === "failure" ? "failed" : "completed")) break;
        if (Date.now() >= deadline) throw new Error("failure did not settle");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const queued = await sendServiceRequest(socketPath, { version: 1, method: "start", workflowId: "queued", requestId: "queued-after-failure" });
      if (!queued.ok) throw new Error(queued.error.message);
      const queuedRunId = serviceStartResultV1Schema.parse(queued.result).runId;
      await waitForCompletedRun(socketPath, "queued", queuedRunId);
      let scheduled: ReturnType<typeof serviceRunsPageV1Schema.parse> | undefined;
      while (Date.now() < deadline) {
        const response = await sendServiceRequest(socketPath, { version: 1, method: "runs", workflowId: "scheduled" });
        if (!response.ok) throw new Error(response.error.message);
        scheduled = serviceRunsPageV1Schema.parse(response.result);
        if (scheduled.runs.length === 2 && scheduled.runs.filter((run) => run.status === "completed").length === (terminalKind === "failure" ? 1 : 2)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(scheduled?.runs).toHaveLength(2);
      expect(scheduled?.runs.find((run) => run.runId === firstRunId)?.status).toBe(terminalKind === "failure" ? "failed" : "completed");
      expect(scheduled?.runs.filter((run) => run.status === "completed")).toHaveLength(terminalKind === "failure" ? 1 : 2);
      if (terminalKind === "early completion") expect(existsSync(successorMarker)).toBe(false);
      const status = await sendServiceRequest(socketPath, { version: 1, method: "status" });
      if (!status.ok) throw new Error(status.error.message);
      expect(statusDtoSchema.parse(status.result).workflows.every((workflow) => workflow.unresolvedRun === null)).toBe(true);
      for (const blockKind of ["verifier_block", "verifier_failed", "repeated_failure"] as const) {
        expect(checkBlockResolution({ formatVersion: 4, blockKind, action: "accept" })).toContain("accept is only available for external_outcome_unknown");
        expect(checkBlockResolution({ formatVersion: 4, blockKind, action: "retry" })).toBeNull();
      }
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}
