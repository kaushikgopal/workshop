import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, resolveCliModel, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentChange } from "@earendil-works/pi-durable";
import type { WorkshopConfig } from "../config/read-workshop-config.ts";

export type OrchestratorModel = {
  model: NonNullable<AgentChange["model"]>;
  thinkingLevel: NonNullable<AgentChange["thinkingLevel"]>;
};

export type OrchestratorRuntime = {
  models: ModelRuntime;
  model: OrchestratorModel;
  escalationModel: OrchestratorModel;
};

export async function createOrchestratorRuntime(projectRoot: string, config: WorkshopConfig): Promise<OrchestratorRuntime> {
  const agentDirectory = join(homedir(), ".pi", "agent");
  const settings = SettingsManager.create(projectRoot, agentDirectory);
  const models = await ModelRuntime.create({
    authPath: join(agentDirectory, "auth.json"),
    modelsPath: join(agentDirectory, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  try {
    const resolve = async (pattern: string | undefined): Promise<OrchestratorModel> => {
      if (pattern !== undefined) {
        const result = await resolveCliModel({ cliModel: pattern, modelRuntime: models });
        if (!result.model) throw new Error(result.error ?? `Pi could not resolve orchestrator model pattern "${pattern}"`);
        return {
          model: { provider: result.model.provider, modelId: result.model.id },
          thinkingLevel: result.thinkingLevel
            ?? settings.getModelThinkingLevel(result.model.provider, result.model.id)
            ?? settings.getDefaultThinkingLevel()
            ?? "medium",
        };
      }

      const provider = settings.getDefaultProvider();
      const modelId = settings.getDefaultModel();
      if (!provider || !modelId) throw new Error("Pi settings do not select a default provider and model");
      if (!models.getModel(provider, modelId)) throw new Error("Pi ModelRuntime cannot resolve the configured default model");
      return {
        model: { provider, modelId },
        thinkingLevel: settings.getModelThinkingLevel(provider, modelId) ?? settings.getDefaultThinkingLevel() ?? "medium",
      };
    };

    return {
      models,
      model: await resolve(config.orchestrator.model),
      escalationModel: await resolve(config.orchestrator.escalation_model),
    };
  } catch (error) {
    await models.settleCredentialWrites();
    throw error;
  }
}
