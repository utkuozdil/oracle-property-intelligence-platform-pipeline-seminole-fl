import { describe, expect, it } from 'vitest';
import { encodeAgentEvent } from './agent-http-stream';

describe('encodeAgentEvent', () => {
  it('writes one NDJSON line per event', () => {
    expect(encodeAgentEvent({ type: 'status', message: 'Searching the snapshot…' })).toBe(
      '{"type":"status","message":"Searching the snapshot…"}\n',
    );
    expect(encodeAgentEvent({ type: 'text', text: 'I found ' })).toBe(
      '{"type":"text","text":"I found "}\n',
    );
  });
});
