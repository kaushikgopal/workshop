import { resolve } from "node:path";
import { defineAgent } from "eve";
import { checkProfileCommands, readConfig } from "./lib/read-config.ts";
import { createProfileModel } from "./lib/create-profile-model.ts";
import { loadWorkflows } from "../workflow/load-workflows.ts";

const config = readConfig();
const commandIssues = checkProfileCommands(config);
if (commandIssues.length > 0) {
  throw new Error(commandIssues.map(({ file, reason }) => `${file}: ${reason}`).join("\n"));
}

const workflows = loadWorkflows(resolve(process.cwd(), "workflows"), new Set(Object.keys(config.agent_profiles)));
for (const issue of workflows.errors) console.error(`[workshop] workflow skipped (${issue.file}): ${issue.reason}`);

const profile = config.agent_profiles[config.orchestrator.profile];
if (!profile) throw new Error(`Orchestrator profile "${config.orchestrator.profile}" was not found`);

export default defineAgent({
  model: createProfileModel(profile.command),
  modelContextWindowTokens: profile.context_window ?? 32_000,
  defaultTools: false,
  tool: false,
});
