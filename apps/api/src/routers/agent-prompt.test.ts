import { describe, expect, it } from 'vitest';
import { AGENT_SYSTEM_PROMPT } from './agent-prompt';
import { AGENT_TOOL_NAMES } from './agent-tools';

describe('AGENT_SYSTEM_PROMPT', () => {
  it('names both tools and treats the messages as the thread', () => {
    for (const name of AGENT_TOOL_NAMES) {
      expect(AGENT_SYSTEM_PROMPT).toContain(name);
    }
    expect(AGENT_SYSTEM_PROMPT).toMatch(/conversation/i);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/follow-up/i);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/contractor/i);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/unknown/i);
  });
});
