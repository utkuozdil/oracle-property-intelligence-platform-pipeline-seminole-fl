/**
 * NDJSON stream for the Oracle agent.
 *
 * Function URL invoke mode is RESPONSE_STREAM, so each line reaches the browser
 * as Bedrock emits it. The tRPC `ask` mutation still exists as a non-stream fallback.
 */

import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { logger } from './observability';
import { answered, askInput, chatted, type AgentAskResponse } from './routers/agent-format';
import { fallbackAsk, getAgentRunner } from './routers/agent';
import type { AgentStreamEvent } from './routers/agent-llm';
import type { AgentThreadContext } from './routers/agent-tools';

export type AgentClientEvent =
  | { type: 'status'; message: string }
  | { type: 'text'; text: string }
  | { type: 'result'; response: AgentAskResponse }
  | { type: 'error'; message: string };

export function encodeAgentEvent(event: AgentClientEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export async function* iterateAgentAsk(input: {
  question: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  currentNear?: string;
  currentRadiusMiles?: number;
  currentRoofAgeMin?: number;
  currentRoofAgeMax?: number;
  currentOpenRoofingOnly?: boolean;
  currentMinOpenRoofingYears?: number;
  currentSort?: string;
}): AsyncGenerator<AgentClientEvent> {
  const thread: AgentThreadContext = {
    currentNear: input.currentNear,
    currentRadiusMiles: input.currentRadiusMiles,
    currentRoofAgeMin: input.currentRoofAgeMin,
    currentRoofAgeMax: input.currentRoofAgeMax,
    currentOpenRoofingOnly: input.currentOpenRoofingOnly,
    currentMinOpenRoofingYears: input.currentMinOpenRoofingYears,
    currentSort: input.currentSort as AgentThreadContext['currentSort'],
  };
  const live = getAgentRunner();
  if (live === null) {
    yield { type: 'status', message: 'Searching the snapshot…' };
    yield { type: 'result', response: await fallbackAsk(input.question, thread) };
    return;
  }

  try {
    let reply = '';
    for await (const event of live.stream({
      question: input.question,
      history: input.history,
      ...thread,
    }) as AsyncGenerator<AgentStreamEvent>) {
      if (event.type === 'status') yield event;
      else if (event.type === 'text') {
        reply += event.text;
        yield event;
      } else if (event.type === 'done') {
        reply = event.reply || reply;
        if (event.search?.ok === true) {
          yield { type: 'result', response: answered(input.question, event.search, reply) };
        } else {
          yield {
            type: 'result',
            response: chatted(
              input.question,
              reply ||
                event.search?.message ||
                'Ask about roofs or open roofing permits near a Seminole County city — Sanford, Lake Mary, Longwood, or Oviedo.',
            ),
          };
        }
      }
    }
  } catch (error: unknown) {
    logger.error('oracle agent stream failed; using fallback parser', {
      error: error instanceof Error ? error.message : String(error),
    });
    yield { type: 'status', message: 'Searching the snapshot…' };
    yield { type: 'result', response: await fallbackAsk(input.question, thread) };
  }
}

export async function writeAgentNdjson(
  event: APIGatewayProxyEventV2,
  responseStream: awslambda.HttpResponseStream,
): Promise<void> {
  const http = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type,accept',
    },
  });

  try {
    const parsed = askInput.safeParse(JSON.parse(event.body ?? '{}'));
    if (!parsed.success) {
      http.write(encodeAgentEvent({ type: 'error', message: 'Send a question in the request body.' }));
      return;
    }
    for await (const chunk of iterateAgentAsk(parsed.data)) {
      http.write(encodeAgentEvent(chunk));
    }
  } catch (error: unknown) {
    http.write(
      encodeAgentEvent({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    http.end();
  }
}
