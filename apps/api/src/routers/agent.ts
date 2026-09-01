import { publicProcedure, router } from '../trpc';
import { logger } from '../observability';
import { createAgentRunner, type AgentRunner } from './agent-llm';
import { agentModel, readAgentModelConfig } from './agent-model';
import { AGENT_EXAMPLES, parseAgentQuestion } from './agent-parse';
import { answered, askInput, chatted, reasoningFromSearch } from './agent-format';
import {
  runAgentSearch,
  type AgentThreadContext,
} from './agent-tools';

let runner: AgentRunner | null | undefined;

export function getAgentRunner(): AgentRunner | null {
  if (runner !== undefined) return runner;
  const config = readAgentModelConfig();
  runner = config === null ? null : createAgentRunner(agentModel(config));
  return runner;
}

export function agentStreamUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.AGENT_STREAM_URL?.trim();
  return url ? url : null;
}

/**
 * Oracle agent: Bedrock + system prompt + tools. Regex parse is only the fallback
 * when the model is not configured or the call fails.
 */
export const agentRouter = router({
  examples: publicProcedure.query(() => ({
    examples: [...AGENT_EXAMPLES],
    streamUrl: agentStreamUrl(),
  })),

  ask: publicProcedure.input(askInput).mutation(async ({ input }) => {
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
    if (live !== null) {
      try {
        const turn = await live.run({
          question: input.question,
          history: input.history,
          ...thread,
        });
        if (turn.search?.ok === true) {
          return answered(input.question, turn.search, turn.reply);
        }
        return chatted(
          input.question,
          turn.reply ||
            turn.search?.message ||
            'Ask about roofs or open roofing permits near a Seminole County city — Sanford, Lake Mary, Longwood, or Oviedo.',
        );
      } catch (error: unknown) {
        logger.error('oracle agent model failed; using fallback parser', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return fallbackAsk(input.question, thread);
  }),
});

export async function fallbackAsk(question: string, thread: AgentThreadContext) {
  const parsed = parseAgentQuestion(question);
  if (parsed.status === 'refused') {
    return chatted(question, parsed.reason);
  }

  const search = await runAgentSearch(
    {
      near: parsed.draft.near,
      usePriorArea: parsed.draft.useCurrentArea,
      keepPriorFilters: parsed.draft.keepPriorFilters,
      radiusMiles: parsed.draft.radiusMiles,
      roofAgeMin: parsed.draft.roofAgeMin,
      openRoofingOnly: parsed.draft.openRoofingOnly,
      minOpenRoofingYears: parsed.draft.minOpenRoofingYears,
    },
    thread,
  );
  if (!search.ok) return chatted(question, search.message);
  return answered(question, search, reasoningFromSearch(search));
}
