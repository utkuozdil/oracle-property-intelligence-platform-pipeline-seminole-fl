import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { streamAgentTurn } from './agent-llm';

describe('streamAgentTurn', () => {
  it('streams a ToolLoopAgent reply without inventing a search', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't0' },
          { type: 'text-delta', id: 't0', delta: 'Seminole has 181,218 parcels.' },
          { type: 'text-end', id: 't0' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: { total: 8 }, outputTokens: { total: 6 } },
          },
        ]),
      }),
    });

    const events = [];
    for await (const event of streamAgentTurn(model, { question: 'How many parcels?' })) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: 'status', message: 'Reading your question…' });
    expect(events.some((event) => event.type === 'text')).toBe(true);
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: 'done',
      reply: 'Seminole has 181,218 parcels.',
      search: undefined,
    });
  });
});
