/**
 * Bedrock model for the Oracle agent’s tool loop.
 *
 * This is a plain Converse model — no generateObject / JSON-schema middleware.
 * Real tools (`list_places`, `search_parcels`) go through Bedrock’s toolConfig.
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { LanguageModel } from 'ai';

export const AGENT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

export interface AgentModelConfig {
  modelId: string;
  region: string;
}

export function readAgentModelConfig(env: NodeJS.ProcessEnv = process.env): AgentModelConfig | null {
  const modelId = env.NLQ_MODEL_ID?.trim();
  if (!modelId) return null;
  return {
    modelId,
    region: env.NLQ_MODEL_REGION?.trim() || env.AWS_REGION?.trim() || 'us-east-2',
  };
}

let cached: { key: string; model: LanguageModel } | undefined;

export function agentModel(config: AgentModelConfig): LanguageModel {
  const key = `${config.region}/${config.modelId}`;
  if (cached?.key === key) return cached.model;

  const bedrock = createAmazonBedrock({
    region: config.region,
    credentialProvider: fromNodeProviderChain(),
  });
  const model = bedrock(config.modelId);
  cached = { key, model };
  return model;
}
