export type StreamAskInput = {
  question: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  currentNear?: string;
  currentRadiusMiles?: number;
  currentRoofAgeMin?: number;
  currentRoofAgeMax?: number;
  currentOpenRoofingOnly?: boolean;
  currentMinOpenRoofingYears?: number;
  currentSort?: string;
};

export type StreamedAskResponse = {
  status: 'answered' | 'refused';
  question: string;
  message?: string;
  reasoning?: string;
  summary?: string;
  [key: string]: unknown;
};

export type AgentClientEvent =
  | { type: 'status'; message: string }
  | { type: 'text'; text: string }
  | { type: 'result'; response: StreamedAskResponse }
  | { type: 'error'; message: string };

export async function readAgentStream(
  url: string,
  input: StreamAskInput,
  onEvent: (event: AgentClientEvent) => void,
): Promise<StreamedAskResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok || response.body === null) {
    throw new Error(response.statusText || `Stream failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: StreamedAskResponse | undefined;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = done ? '' : (lines.pop() ?? '');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const event = JSON.parse(trimmed) as AgentClientEvent;
      onEvent(event);
      if (event.type === 'result') result = event.response;
      if (event.type === 'error') throw new Error(event.message);
    }
    if (done) break;
  }

  if (result === undefined) throw new Error('The agent stream ended without an answer.');
  return result;
}
