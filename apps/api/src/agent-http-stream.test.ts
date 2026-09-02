import { describe, expect, it } from 'vitest';
import { AGENT_STREAM_RESPONSE_HEADERS, encodeAgentEvent } from './agent-http-stream';

describe('encodeAgentEvent', () => {
  it('does not set CORS on the body; the Function URL owns those headers', () => {
    const names = Object.keys(AGENT_STREAM_RESPONSE_HEADERS).join(' ');
    expect(names).not.toMatch(/access-control/i);
    expect(AGENT_STREAM_RESPONSE_HEADERS['content-type']).toMatch(/ndjson/);
  });

  it('writes one NDJSON line per event', () => {
    expect(encodeAgentEvent({ type: 'status', message: 'Searching the snapshot…' })).toBe(
      '{"type":"status","message":"Searching the snapshot…"}\n',
    );
    expect(encodeAgentEvent({ type: 'text', text: 'I found ' })).toBe(
      '{"type":"text","text":"I found "}\n',
    );
  });
});
