import type { ResolvedExecutionSite } from "../../definition/schema-resolved.js";
import { resolveRetryLimit } from "../../definition/resolve-retry-limit.js";
import type { WorkflowRunDocumentV1, PersistedNodeAttempt } from "../../run/records.js";
import type { NodeResult, ValidatorOutcome } from "../../run/schema.js";
import type { ProcessExit } from "../../process/schema.js";

/** Render committed run state as Markdown: one line per attempt, or every setting and hash when verbose. */
export function renderWorklog(value: WorkflowRunDocumentV1, options: { readonly verbose?: boolean } = {}): string {
  if (value.state !== "ready") throw new Error("cannot render an uninitialized run");
  const run = value;
  if (!options.verbose) return renderCompactWorklog(run);
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
  if (!("formatVersion" in run.resolvedSettings) && run.resolvedSettings.orchestrator.model !== null) {
    lines.push(`- Failure judge model: ${run.resolvedSettings.orchestrator.model}`);
  }

  lines.push("", "## Step attempts", "");
  for (const node of run.nodes) {
    const settings = run.resolvedSettings.nodes[node.nodeId];
    lines.push(`### ${node.nodeId} — ${node.status}`, "");
    if (settings !== undefined) {
      lines.push(`- Worker: ${describeSite(settings.run)}`);
      if (settings.validator !== null) lines.push(`- Validator: ${describeSite(settings.validator)}`);
      lines.push(`- Retries: ${resolveRetryLimit(settings)}`);
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
        if (candidate.version === 2) {
          lines.push("- Stdout result: " + candidate.stdioResult.mode + " / " + candidate.stdioResult.status);
          if (candidate.stdioResult.question !== null) lines.push("- Question:", ...quote(candidate.stdioResult.question));
        } else if (candidate.version === 3) {
          lines.push("- Native result: " + candidate.agentResult.mode + " / " + candidate.agentResult.status);
          lines.push("- Native execution: " + inlineCode(candidate.nativeExecution.executionId)
            + "; conversation " + candidate.nativeExecution.conversationId
            + "; assistant entry " + candidate.nativeExecution.assistantEntryId
            + "; final-text SHA-256 " + candidate.nativeExecution.finalTextSha256);
          if (candidate.agentResult.question !== null) lines.push("- Question:", ...quote(candidate.agentResult.question));
        }
        if (candidate.source === "operator") {
          lines.push(`- Acceptance provenance: ${candidate.acceptance.provenance}; resolution: ${inlineCode(candidate.acceptance.resolutionId)}`);
          lines.push(...quote(candidate.acceptance.reason));
        } else if (candidate.version !== 3) {
          lines.push(`- Worker exit: ${describeExit(candidate.exit)}`);
        }
        lines.push("- Summary:", ...quote(candidate.summary));
        for (const artifact of candidate.artifacts) {
          lines.push(`- Artifact (${inlineCode(artifact.kind)}): ${artifact.availability}`, ...quote(artifact.path));
        }
      }

      const nativeWorkerFailure = attempt.workerFailure?.nativeExecution
        ?? (attempt.result.kind === "settled" && attempt.result.outcome.kind === "failed"
          ? attempt.result.outcome.failure.nativeExecution : undefined);
      if (nativeWorkerFailure !== undefined) {
        lines.push("- Native worker failure execution: " + inlineCode(nativeWorkerFailure.executionId)
          + "; conversation " + nativeWorkerFailure.conversationId
          + "; assistant entry " + nativeWorkerFailure.assistantEntryId
          + "; final-text SHA-256 " + nativeWorkerFailure.finalTextSha256);
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

  if (run.resolutions.length > 0) {
    lines.push("## Global decision log", "");
    for (const resolution of run.resolutions) {
      lines.push(`- ${resolution.resolvedAt}: ${resolution.action} (${inlineCode(resolution.resolutionId)}; ${resolution.provenance})`);
      lines.push(...quote(resolution.reason));
    }
  }

  for (const wait of run.waits ?? []) {
    lines.push("", "## Human wait", "", "- Wait ID: " + wait.waitId, "- Step: " + wait.nodeId,
      "- Question:", ...quote(wait.question), "- Proposal:", ...quote(wait.output));
    if (wait.settlement.kind === "replied") lines.push("- Human reply: " + wait.settlement.action,
      "- Answer:", ...quote(wait.settlement.answer));
    else lines.push("- Wait: " + wait.settlement.kind);
  }
  lines.push("", "## Run outcome", "", `- Status: ${run.status}`, `- Desired state: ${run.desiredState}`);
  if (run.finishedAt !== null) lines.push(`- Finished: ${run.finishedAt}`);
  if (run.terminalOutput !== null) lines.push(`- Terminal output: ${Buffer.byteLength(run.terminalOutput, "utf8")} bytes from the final step`);
  if (run.failure !== null) {
    const reason = run.failure.kind === "operator" ? run.failure.reason : run.failure.message;
    lines.push(`- Failure: ${run.failure.kind} —`, ...quote(reason));
  }
  if (run.block !== null) lines.push(`- Block: ${run.block.kind} —`, ...quote(run.block.reason));
  return `${lines.join("\n")}\n`;
}

function candidateOf(attempt: PersistedNodeAttempt): NodeResult | null {
  const result = attempt.result;
  if (result.kind === "candidate_committed" || result.kind === "validation_committed") return result.candidate;
  if (result.kind !== "settled" || result.outcome.kind === "cancelled") return null;
  return result.outcome.candidate;
}

function validatorOf(attempt: PersistedNodeAttempt): ValidatorOutcome | null {
  const result = attempt.result;
  if (result.kind === "validation_committed") return result.validator;
  if (result.kind !== "settled" || result.outcome.kind === "cancelled") return null;
  return result.outcome.validator;
}

function describeValidator(validator: ValidatorOutcome): string[] {
  const lines = [`- Validator result: ${validator.kind}`];
  if (validator.kind === "command") {
    lines.push(`  - Exit: ${describeExit(validator.exit)}`);
    lines.push(`  - Stdout SHA-256: ${validator.stdoutHash ?? "not captured"}`);
    lines.push(`  - Stderr SHA-256: ${validator.stderrHash ?? "not captured"}`);
  } else {
    if (validator.kind === "native_agent") {
      lines.push("  - Native verifier execution: " + inlineCode(validator.nativeExecution.executionId)
        + "; conversation " + validator.nativeExecution.conversationId
        + "; assistant entry " + validator.nativeExecution.assistantEntryId
        + "; final-text SHA-256 " + validator.nativeExecution.finalTextSha256);
    }
    lines.push(...describeVerdict(validator.verdict));
  }
  return lines;
}

type AgentOrOperatorVerdict = Extract<ValidatorOutcome, { kind: "agent" | "native_agent" | "operator" }>["verdict"];

function describeVerdict(verdict: AgentOrOperatorVerdict): string[] {
  if (verdict.version === 1) {
    return ["  - Verdict: " + (verdict.passed ? "passed" : "rejected"), ...quote(verdict.reason)];
  }
  return [
    "  - Decision: " + verdict.decision,
    ...quote(verdict.reason),
  ];
}

function renderedVerdictReason(verdict: AgentOrOperatorVerdict): string {
  return verdict.version === 1
    ? verdict.reason
    : verdict.decision + ": " + verdict.reason;
}

function describeSite(site: ResolvedExecutionSite): string {
  const timeout = site.timeoutMs === null ? "unlimited" : `${site.timeoutMs} ms`;
  const cap = site.streamCapBytes === "unlimited" ? "unlimited" : `${site.streamCapBytes} bytes`;
  const model = site.kind === "agent" ? `, model ${site.model}` : "";
  return `${site.kind}${model}, shell ${inlineCode(site.shell)}, cwd ${inlineCode(site.cwd)}, timeout ${timeout}, diagnostic cap ${cap}, replay ${site.replay}`;
}

function describeExit(exit: ProcessExit): string {
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

function renderCompactWorklog(run: Extract<WorkflowRunDocumentV1, { state: "ready" }>): string {
  const lines = [
    `# ${run.workflowId} — ${run.status}`,
    `Run ${run.runId} · admitted ${run.admittedAt}`,
    "",
  ];
  for (const node of run.nodes) {
    for (const attempt of node.attempts) {
      const outcome = attempt.result.kind === "settled" ? attempt.result.outcome.kind : attempt.status;
      const duration = attempt.elapsedMs === null ? "—" : `${attempt.elapsedMs}ms`;
      const candidate = candidateOf(attempt);
      const outcomeDetail = attempt.result.kind === "settled"
        ? attempt.result.outcome.kind === "failed" ? attempt.result.outcome.failure.message
          : attempt.result.outcome.kind === "blocked" ? attempt.result.outcome.block.reason
            : ""
        : "";
      const candidateSummary = candidate === null ? "" : candidate.version === 1
        ? candidate.summary
        : candidate.version === 2
          ? [candidate.stdioResult.mode + " " + candidate.stdioResult.status, candidate.summary,
            candidate.stdioResult.question === null ? "" : "Question: " + candidate.stdioResult.question].filter(Boolean).join(" · ")
          : [candidate.agentResult.mode + " " + candidate.agentResult.status, candidate.summary,
            candidate.agentResult.question === null ? "" : "Question: " + candidate.agentResult.question].filter(Boolean).join(" · ");
      const summary = compactText(candidateSummary || outcomeDetail || "no summary");
      const validator = validatorOf(attempt);
      const verdictReason = validator?.kind === "agent" || validator?.kind === "native_agent" || validator?.kind === "operator"
        ? compactText(renderedVerdictReason(validator.verdict))
        : null;
      lines.push(`- ${node.nodeId} #${attempt.number} ${outcome} · ${duration} · ${summary}${verdictReason === null ? "" : ` · decision: ${verdictReason}`}`);
    }
  }
  if (run.resolutions.length > 0) {
    lines.push("", "## Global decision log");
    for (const resolution of run.resolutions) {
      lines.push(`- ${resolution.resolvedAt}: ${resolution.action} — ${compactText(resolution.reason)}`);
    }
  }
  for (const wait of run.waits ?? []) {
    lines.push("", (wait.settlement.kind === "pending" ? "Needs input: " : "Human wait: ") + wait.nodeId + " · waitId=" + wait.waitId,
      "Question:", ...quote(wait.question));
    if (wait.settlement.kind === "replied") lines.push("Human reply: " + wait.settlement.action, ...quote(wait.settlement.answer));
    else if (wait.settlement.kind === "stopped") lines.push("Wait stopped.");
  }
  return `${lines.join("\n")}\n`;
}

function compactText(value: string, maximumCharacters = 180): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(oneLine);
  if (characters.length <= maximumCharacters) return oneLine;
  return `${characters.slice(0, maximumCharacters - 1).join("").trimEnd()}…`;
}
