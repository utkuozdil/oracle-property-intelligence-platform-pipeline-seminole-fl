import { describe, expect, it } from 'vitest';
import { AGENT_MODEL_ID, readAgentModelConfig } from './agent-model';

describe('readAgentModelConfig', () => {
  it('is off when NLQ_MODEL_ID is missing', () => {
    expect(readAgentModelConfig({})).toBeNull();
    expect(readAgentModelConfig({ NLQ_MODEL_ID: '   ' })).toBeNull();
  });

  it('reads the configured Haiku 4.5 id', () => {
    expect(
      readAgentModelConfig({
        NLQ_MODEL_ID: AGENT_MODEL_ID,
        AWS_REGION: 'us-east-2',
      }),
    ).toEqual({ modelId: AGENT_MODEL_ID, region: 'us-east-2' });
  });
});
