/**
 * One agent turn: ToolLoopAgent + Bedrock, streamed.
 *
 * The model may call `list_places` / `search_parcels`. Rows come only from those tools.
 * Tokens are yielded as they arrive so the chat can paint them.
 */

import { ToolLoopAgent, stepCountIs, type LanguageModel, type ModelMessage } from 'ai';
import { AGENT_SYSTEM_PROMPT } from './agent-prompt';
import {
  createAgentTools,
  type AgentSearchResult,
  type AgentThreadContext,
} from './agent-tools';

export interface AgentHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentTurnContext extends AgentThreadContext {
  question: string;
  history?: AgentHistoryTurn[];
}

export interface AgentTurnResult {
  reply: string;
  search: AgentSearchResult | undefined;
}

export type AgentStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'text'; text: string }
  | { type: 'done'; reply: string; search: AgentSearchResult | undefined };

export interface AgentRunner {
  stream(context: AgentTurnContext): AsyncGenerator<AgentStreamEvent>;
  run(context: AgentTurnContext): Promise<AgentTurnResult>;
}

function toolStatus(toolName: string): string {
  if (toolName === 'search_parcels') return 'Searching the snapshot…';
  if (toolName === 'list_places') return 'Checking Seminole places…';
  return `Using ${toolName}…`;
}

export async function* streamAgentTurn(
  model: LanguageModel,
  context: AgentTurnContext,
): AsyncGenerator<AgentStreamEvent> {
  const sink: { lastSearch?: AgentSearchResult } = {};
  const tools = createAgentTools(context, sink);
  yield { type: 'status', message: 'Reading your question…' };

  const messages: ModelMessage[] = [
    ...(context.history ?? []).map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
    { role: 'user' as const, content: context.question },
  ];

  const agent = new ToolLoopAgent({
    id: 'oracle-seminole',
    model,
    instructions: AGENT_SYSTEM_PROMPT,
    tools,
    stopWhen: stepCountIs(4),
    temperature: 0,
    maxOutputTokens: 700,
    maxRetries: 1,
  });
  const result = await agent.stream({
    messages,
    abortSignal: AbortSignal.timeout(18_000),
  });

  for await (const part of result.fullStream) {
    if (part.type === 'tool-call') {
      yield { type: 'status', message: toolStatus(part.toolName) };
    } else if (part.type === 'text-delta' && part.text.length > 0) {
      yield { type: 'text', text: part.text };
    } else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }

  const reply = (await result.text).trim();
  yield { type: 'done', reply, search: sink.lastSearch };
}

export function createAgentRunner(model: LanguageModel): AgentRunner {
  return {
    stream(context: AgentTurnContext) {
      return streamAgentTurn(model, context);
    },
    async run(context: AgentTurnContext): Promise<AgentTurnResult> {
      let reply = '';
      let search: AgentSearchResult | undefined;
      for await (const event of streamAgentTurn(model, context)) {
        if (event.type === 'text') reply += event.text;
        if (event.type === 'done') {
          reply = event.reply;
          search = event.search;
        }
      }
      return { reply, search };
    },
  };
}
