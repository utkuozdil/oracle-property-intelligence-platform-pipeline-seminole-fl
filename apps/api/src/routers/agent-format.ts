import { z } from 'zod';
import { AGENT_EXAMPLES } from './agent-parse';
import type { AgentSearchSuccess } from './agent-tools';

export const historyTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(1200),
});

export const askInput = z.object({
  question: z.string().trim().min(1).max(400),
  history: z.array(historyTurn).max(16).optional(),
  currentNear: z.string().max(120).optional(),
  currentRadiusMiles: z.number().positive().max(50).optional(),
  currentRoofAgeMin: z.number().min(0).max(400).optional(),
  currentRoofAgeMax: z.number().min(0).max(400).optional(),
  currentOpenRoofingOnly: z.boolean().optional(),
  currentMinOpenRoofingYears: z.number().min(0).max(80).optional(),
  currentSort: z.string().max(40).optional(),
});

export type AskInput = z.infer<typeof askInput>;

export function chatted(question: string, message: string) {
  return {
    status: 'refused' as const,
    question,
    message,
    examples: [...AGENT_EXAMPLES],
  };
}

export function answered(question: string, search: AgentSearchSuccess, reply: string) {
  const summaryParts = search.criteria
    .filter((criterion) => criterion.key !== 'sort')
    .map((criterion) => criterion.label);
  const locationLabel = `within ${search.radiusMiles} miles of ${search.near}`;
  const reasoning = reply.trim() || reasoningFromSearch(search);

  return {
    status: 'answered' as const,
    question,
    summary: `${capitalise(summaryParts.join(', ') || locationLabel)} — ${search.total} ${search.total === 1 ? 'match' : 'matches'}.`,
    reasoning,
    criteria: search.criteria,
    notes: search.notes,
    evidence: search.evidence,
    query: {
      near: search.near,
      radiusMiles: search.radiusMiles,
      roofAgeMin: search.roofAgeMin ?? null,
      roofAgeMax: search.roofAgeMax ?? null,
      openRoofingOnly: search.openRoofingOnly,
      minOpenRoofingYears: search.minOpenRoofingYears,
      sort: search.sort,
    },
    centre: search.centre,
    total: search.total,
    rows: search.rows,
    source: search.source,
    examples: [...AGENT_EXAMPLES],
  };
}

export type AgentAskResponse = ReturnType<typeof answered> | ReturnType<typeof chatted>;

export function reasoningFromSearch(search: AgentSearchSuccess): string {
  const parts = [
    `I searched the published Seminole snapshot within ${search.radiusMiles} miles of ${search.near}`,
  ];
  if (search.roofAgeMin !== undefined) {
    parts.push(`for roofs at least ${search.roofAgeMin} years old`);
  }
  if (search.roofAgeMax !== undefined) {
    parts.push(`for roofs at most ${search.roofAgeMax} years old`);
  }
  if (search.openRoofingOnly) {
    parts.push(
      search.minOpenRoofingYears !== null
        ? `for confirmed-open roofing permits held open at least ${search.minOpenRoofingYears} years`
        : 'for confirmed-open roofing permits',
    );
  }
  parts.push(search.sort.replaceAll('_', ' '));
  const matches = `${search.total} ${search.total === 1 ? 'parcel matches' : 'parcels match'}`;
  return `${parts.join(', ')}. ${matches}.`;
}

function capitalise(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
