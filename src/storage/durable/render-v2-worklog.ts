import type { ResolvedExecutionSiteV2 } from "../../definition/schema-resolved-v2.js";
import type { WorkflowRunDocumentV1, PersistedNodeAttemptV2 } from "../../run/records-v2.js";
import type { NodeResultV2, ValidatorOutcomeV2 } from "../../run/schema-v2.js";
import type { ProcessExitV2 } from "../../process/schema-v2.js";

/** Render committed run state as a Markdown view; user-authored text stays quoted. */
export function renderV2Worklog(value: WorkflowRunDocumentV1): string {
  if (value.state !== "ready") throw new Error("cannot render an uninitialized run");
  const run = value;
  const lines = [
    `# Workflow run: ${run.workflowId}`,
    "",
    "## Goal",
    "",
    ...quote(run.canonicalDefinition.description ?? `Execute the frozen workflow ${run.workflowId}.`),
    "",
    "## Environment",
    "",
    `- Run: ${run.runId}`,
    `- Admitted: ${run.admittedAt}`,
    `- Project directory: ${inlineCode(run.paths.projectCwd)}`,
    `- Frozen source SHA-256: ${run.sourceHash}`,
    `- Frozen definition SHA-256: ${run.canonicalHash}`,
  ];

  if (run.resolvedSettings.preflight !== null) lines.push(`- Preflight: ${run.preflight.kind}`);
  if (run.resolvedSettings.orchestrator.model !== null) {
    lines.push(`- Failure judge model: ${run.resolvedSettings.orchestrator.model}`);
  }

  lines.push("", "## Node attempts", "");
  for (const node of run.nodes) {
    const settings = run.resolvedSettings.nodes[node.nodeId];
    lines.push(`### ${node.nodeId} — ${node.status}`, "");
    if (settings !== undefined) {
      lines.push(`- Worker: ${describeSite(settings.run)}`);
      if (settings.validator !== null) lines.push(`- Validator: ${describeSite(settings.validator)}`);
      lines.push(`- Maximum attempts: ${settings.maxAttempts}`);
    }
    if (node.attempts.length === 0) {
      lines.push("- No attempt has started.", "");
      continue;
    }

    for (const attempt of node.attempts) {
      lines.push(`#### Attempt ${attempt.number}`, "");
      lines.push(`- Attempt ID: ${inlineCode(attempt.attemptId)}`);
      lines.push(`- Status: ${attempt.status}`);
      if (attempt.startedAt !== null) lines.push(`- Started: ${attempt.startedAt}`);
      if (attempt.finishedAt !== null) lines.push(`- Finished: ${attempt.finishedAt}`);
      if (attempt.elapsedMs !== null) lines.push(`- Elapsed: ${attempt.elapsedMs} ms`);

      const candidate = candidateOf(attempt);
      if (candidate !== null) {
        lines.push(`- Candidate source: ${candidate.source}`);
        lines.push(`- Candidate SHA-256: ${candidate.sourceBytesHash}`);
        lines.push(`- Output view: ${inlineCode(`${node.nodeId}.output.txt`)}`);
        if (candidate.source === "operator") {
          lines.push(`- Operator acceptance: ${inlineCode(candidate.acceptance.resolutionId)}`);
          lines.push(...quote(candidate.acceptance.reason));
        } else {
          lines.push(`- Worker exit: ${describeExit(candidate.exit)}`);
        }
        lines.push("- Summary:", ...quote(candidate.summary));
        for (const artifact of candidate.artifacts) {
          lines.push(`- Artifact (${inlineCode(artifact.kind)}): ${artifact.availability}`, ...quote(artifact.path));
        }
      }

      const validator = validatorOf(attempt);
      if (validator !== null) lines.push(...describeValidator(validator));
      if (attempt.result.kind === "settled") {
        const outcome = attempt.result.outcome;
        if (outcome.kind === "failed") {
          lines.push(`- Failure: ${outcome.failure.kind} —`, ...quote(outcome.failure.message));
        } else if (outcome.kind === "blocked") {
          lines.push(`- Block: ${outcome.block.kind} —`, ...quote(outcome.block.reason));
        } else if (outcome.kind === "cancelled") {
          lines.push("- Outcome: cancelled");
        } else {
          lines.push("- Outcome: succeeded");
        }
      } else {
        lines.push(`- Current phase: ${attempt.phase ?? "unknown"}`);
      }

      for (const judgment of attempt.judgments) {
        lines.push(`- Failure judgment ${inlineCode(judgment.judgmentId)}: ${judgment.status}`);
        if (judgment.decision !== null) {
          lines.push(`  - Decision: ${judgment.decision.action}`, ...quote(judgment.decision.reason));
        }
      }
      lines.push("");
    }
  }

  lines.push("## Global decision log", "");
  if (run.resolutions.length === 0) lines.push("No operator resolutions.", "");
  for (const resolution of run.resolutions) {
    lines.push(`- ${resolution.resolvedAt}: ${resolution.action} (${inlineCode(resolution.resolutionId)})`);
    lines.push(...quote(resolution.reason));
  }

  lines.push("", "## Run outcome", "", `- Status: ${run.status}`, `- Desired state: ${run.desiredState}`);
  if (run.finishedAt !== null) lines.push(`- Finished: ${run.finishedAt}`);
  if (run.terminalOutput !== null) lines.push("- Terminal output is materialized in the final node output view.");
  if (run.failure !== null) {
    const reason = run.failure.kind === "operator" ? run.failure.reason : run.failure.message;
    lines.push(`- Failure: ${run.failure.kind} —`, ...quote(reason));
  }
  if (run.block !== null) lines.push(`- Block: ${run.block.kind} —`, ...quote(run.block.reason));
  return `${lines.join("\n")}\n`;
}

function candidateOf(attempt: PersistedNodeAttemptV2): NodeResultV2 | null {
  const result = attempt.result;
  if (result.kind === "candidate_committed" || result.kind === "validation_committed") return result.candidate;
  if (result.kind !== "settled" || result.outcome.kind === "cancelled") return null;
  return result.outcome.candidate;
}

function validatorOf(attempt: PersistedNodeAttemptV2): ValidatorOutcomeV2 | null {
  const result = attempt.result;
  if (result.kind === "validation_committed") return result.validator;
  if (result.kind !== "settled" || result.outcome.kind === "cancelled") return null;
  return result.outcome.validator;
}

function describeValidator(validator: ValidatorOutcomeV2): string[] {
  const lines = [`- Validator result: ${validator.kind}`];
  if (validator.kind === "command") {
    lines.push(`  - Exit: ${describeExit(validator.exit)}`);
    lines.push(`  - Stdout SHA-256: ${validator.stdoutHash ?? "not captured"}`);
    lines.push(`  - Stderr SHA-256: ${validator.stderrHash ?? "not captured"}`);
  } else {
    lines.push(`  - Verdict: ${validator.verdict.passed ? "passed" : "rejected"}`);
    lines.push(...quote(validator.verdict.reason));
  }
  return lines;
}

function describeSite(site: ResolvedExecutionSiteV2): string {
  const timeout = site.timeoutMs === null ? "unlimited" : `${site.timeoutMs} ms`;
  const cap = site.streamCapBytes === "unlimited" ? "unlimited" : `${site.streamCapBytes} bytes`;
  const model = site.kind === "agent" ? `, model ${site.model}` : "";
  return `${site.kind}${model}, shell ${inlineCode(site.shell)}, cwd ${inlineCode(site.cwd)}, timeout ${timeout}, diagnostic cap ${cap}, replay ${site.replay}`;
}

function describeExit(exit: ProcessExitV2): string {
  return exit.kind === "code" ? `code ${exit.code}` : `signal ${exit.signal}`;
}

function quote(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => `> ${line}`);
}

function inlineCode(value: string): string {
  let longestRun = 0;
  let currentRun = 0;
  for (const character of value) {
    currentRun = character === "`" ? currentRun + 1 : 0;
    longestRun = Math.max(longestRun, currentRun);
  }
  const delimiter = "`".repeat(longestRun + 1);
  const padding = value.trim() !== value || value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}
