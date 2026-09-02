import { useEffect, useRef, useState } from 'react';
import { readAgentStream } from './agent-stream';
import { api } from './api';
import {
  MISSING,
  formatBbb,
  formatCount,
  formatMiles,
  formatNumber,
  formatYearsOpen,
} from './format';

type AskResponse = Awaited<ReturnType<typeof api.agent.ask.mutate>>;
type Answered = Extract<AskResponse, { status: 'answered' }>;

type ChatTurn =
  | { role: 'user'; question: string }
  | { role: 'assistant'; response: AskResponse }
  | { role: 'error'; message: string };

export interface AgentViewProps {
  currentNear: string;
  currentRadiusMiles: string;
  currentRoofAgeMin: string;
  onOpenParcel: (parcelId: string) => void;
}

const TURNS_KEY = 'oracle-agent-turns';

function readPersistedTurns(): ChatTurn[] {
  try {
    const raw = sessionStorage.getItem(TURNS_KEY);
    if (raw !== null) return JSON.parse(raw) as ChatTurn[];
  } catch {
    /* private mode or a stale payload */
  }
  return [];
}

function writePersistedTurns(turns: ChatTurn[]): void {
  try {
    sessionStorage.setItem(TURNS_KEY, JSON.stringify(turns));
  } catch {
    /* quota / private mode */
  }
}

/**
 * Full-page chat. Each ask appends a turn. The thread is stored in the session so
 * opening a parcel and coming Back does not wipe it.
 */
export function AgentView({
  currentNear,
  currentRadiusMiles,
  onOpenParcel,
}: AgentViewProps) {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [turns, setTurnsState] = useState<ChatTurn[]>(readPersistedTurns);
  const [streamUrl, setStreamUrl] = useState<string | null>(
    import.meta.env.VITE_AGENT_STREAM_URL ?? null,
  );
  const [liveText, setLiveText] = useState('');
  const [liveStatus, setLiveStatus] = useState('Searching the snapshot…');
  const threadRef = useRef<HTMLDivElement>(null);
  const askingRef = useRef(false);

  const setTurns = (update: ChatTurn[] | ((current: ChatTurn[]) => ChatTurn[])): void => {
    setTurnsState((current) => {
      const next = typeof update === 'function' ? update(current) : update;
      writePersistedTurns(next);
      return next;
    });
  };

  useEffect(() => {
    api.agent.examples
      .query()
      .then((response) => {
        if (response.streamUrl) setStreamUrl(response.streamUrl);
      })
      .catch(() => {
        /* stream URL stays at the build-time default */
      });
  }, []);

  useEffect(() => {
    threadRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [turns, asking]);

  const lastAnswer = [...turns]
    .reverse()
    .find((turn): turn is { role: 'assistant'; response: Answered } => {
      return turn.role === 'assistant' && turn.response.status === 'answered';
    });

  const submit = async (raw: string): Promise<void> => {
    const trimmed = raw.trim();
    if (trimmed === '' || askingRef.current) return;
    const lastUser = [...turns].reverse().find((turn) => turn.role === 'user');
    if (lastUser?.role === 'user' && lastUser.question === trimmed && lastAnswer !== undefined) {
      setQuestion('');
      return;
    }
    askingRef.current = true;
    setQuestion('');
    setLiveText('');
    setLiveStatus('Reading your question…');
    setTurns((current) => [...current, { role: 'user', question: trimmed }]);
    setAsking(true);
    try {
      const prior = lastAnswer?.response.query;
      const input = {
        question: trimmed,
        history: historyFromTurns(turns),
        currentNear: prior?.near ?? (currentNear.trim() === '' ? undefined : currentNear.trim()),
        currentRadiusMiles: prior?.radiusMiles ?? Number(currentRadiusMiles || 5),
        currentRoofAgeMin: prior?.roofAgeMin ?? undefined,
        currentRoofAgeMax: prior?.roofAgeMax ?? undefined,
        currentOpenRoofingOnly: prior?.openRoofingOnly,
        currentMinOpenRoofingYears: prior?.minOpenRoofingYears ?? undefined,
        currentSort: prior?.sort,
      };
      let response: AskResponse;
      if (streamUrl) {
        try {
          response = (await readAgentStream(streamUrl, input, (event) => {
            if (event.type === 'status') setLiveStatus(event.message);
            if (event.type === 'text') setLiveText((current) => current + event.text);
          })) as AskResponse;
        } catch (error: unknown) {
          console.error('oracle agent stream failed; using buffered ask', error);
          setLiveStatus('Searching the snapshot…');
          response = await api.agent.ask.mutate(input);
        }
      } else {
        response = await api.agent.ask.mutate(input);
      }
      setTurns((current) => [...current, { role: 'assistant', response }]);
    } catch (error: unknown) {
      setTurns((current) => [
        ...current,
        { role: 'error', message: error instanceof Error ? error.message : String(error) },
      ]);
    } finally {
      askingRef.current = false;
      setAsking(false);
    }
  };

  const startOver = (): void => {
    askingRef.current = false;
    setAsking(false);
    setQuestion('');
    setLiveText('');
    setTurns([]);
  };

  return (
    <section className="chat" data-testid="agent-view" aria-labelledby="agent-heading">
      <header className="chat-toolbar">
        <p className="detail-sub" id="agent-heading">
          Ask a Seminole County property question. Follow-ups keep the last place.
        </p>
        <button
          className="button button--ghost"
          type="button"
          data-testid="oracle-agent-clear"
          disabled={turns.length === 0 && question.trim() === ''}
          onClick={startOver}
        >
          Clear conversation
        </button>
      </header>

      <div className="chat-thread" ref={threadRef} data-testid="agent-thread">
        {turns.length === 0 && (
          <div className="chat-bubble chat-bubble--assistant" data-testid="agent-welcome">
            <p>
              I return matching parcels from the published snapshot, say how I filtered,
              and name the source. Try a city in this county — Sanford, Lake Mary,
              Longwood, Oviedo.
            </p>
          </div>
        )}

        {turns.map((turn, index) => {
          if (turn.role === 'user') {
            return (
              <div
                key={`u-${index}`}
                className="chat-bubble chat-bubble--user"
                data-testid="agent-user-turn"
              >
                {turn.question}
              </div>
            );
          }
          if (turn.role === 'error') {
            return (
              <div
                key={`e-${index}`}
                className="chat-bubble chat-bubble--assistant"
                data-testid="oracle-agent-refused"
              >
                <p>{turn.message}</p>
              </div>
            );
          }
          return (
            <AssistantBubble
              key={`a-${index}`}
              response={turn.response}
              onOpenParcel={onOpenParcel}
            />
          );
        })}

        {asking && (
          <div className="chat-bubble chat-bubble--assistant" data-testid="agent-thinking">
            {liveText ? (
              <p className="agent-summary">
                {liveText}
                <span className="agent-cursor" aria-hidden="true" />
              </p>
            ) : (
              <p>{liveStatus}</p>
            )}
          </div>
        )}
      </div>

      <form
        className="chat-composer"
        data-testid="agent-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(question);
        }}
      >
        <label htmlFor="oracle-agent-input" className="sr-only">
          Question
        </label>
        <textarea
          id="oracle-agent-input"
          data-testid="oracle-agent-input"
          rows={2}
          placeholder="Ask about roofs or open roofing permits near a Seminole County city…"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit(question);
            }
          }}
        />
        <button
          className="button button--primary"
          type="submit"
          data-testid="oracle-agent-ask"
          disabled={asking || question.trim() === ''}
        >
          {asking ? 'Asking…' : 'Ask'}
        </button>
        <button
          className="button button--ghost"
          type="button"
          data-testid="oracle-agent-clear-composer"
          disabled={asking || (turns.length === 0 && question.trim() === '')}
          onClick={startOver}
        >
          Clear
        </button>
      </form>
    </section>
  );
}

function AssistantBubble({
  response,
  onOpenParcel,
}: {
  response: AskResponse;
  onOpenParcel: (parcelId: string) => void;
}) {
  if (response.status !== 'answered') {
    return (
      <div className="chat-bubble chat-bubble--assistant" data-testid="oracle-agent-refused">
        <p>{response.message}</p>
      </div>
    );
  }

  const reasoning =
    'reasoning' in response && typeof response.reasoning === 'string'
      ? response.reasoning
      : response.summary;
  const evidence =
    'evidence' in response && typeof response.evidence === 'string'
      ? response.evidence
      : compactSource(response);

  return (
    <div className="chat-bubble chat-bubble--assistant" data-testid="oracle-agent-answer">
      <p className="agent-summary" data-testid="oracle-agent-summary">
        {reasoning}
      </p>
      <p className="agent-count" data-testid="oracle-agent-criteria">
        {response.summary}
      </p>

      {response.rows.length === 0 ? (
        <p className="footnote">No parcels matched those filters.</p>
      ) : (
        <ul className="chat-hits" data-testid="oracle-agent-hits">
          {response.rows.map((row) => (
            <li key={row.parcelId} className="chat-hit">
              <button
                type="button"
                className="link"
                data-testid="agent-parcel-link"
                onClick={() => onOpenParcel(row.parcelId)}
              >
                {row.displayTitle}
              </button>
              <span className="row-sub">{row.parcelId}</span>
              <div className="chat-hit-meta">
                <span>{formatMiles(row.distanceMiles)}</span>
                <span>Roof {formatNumber(row.roofAge)}</span>
                <span data-testid="agent-cell-open-years">
                  Open {formatYearsOpen(row.openRoofing?.maxOpenYears)}
                </span>
                <span data-testid="agent-cell-contractor">
                  {row.openRoofing?.contractorName ?? MISSING}
                </span>
                <span data-testid="agent-cell-bbb">
                  {formatBbb(row.openRoofing?.bbbRating, row.openRoofing?.bbbLookup)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {response.total > response.rows.length && (
        <p className="footnote">
          Showing {formatCount(response.rows.length)} of {formatCount(response.total)}.
        </p>
      )}

      <p className="footnote" data-testid="oracle-agent-source">
        {evidence}
      </p>
    </div>
  );
}

function historyFromTurns(turns: ChatTurn[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.question });
      continue;
    }
    if (turn.role !== 'assistant') continue;
    const content =
      turn.response.status === 'answered'
        ? [turn.response.reasoning, turn.response.summary].filter(Boolean).join('\n')
        : turn.response.message;
    if (content !== undefined && content.trim() !== '') {
      messages.push({ role: 'assistant', content: content.slice(0, 1200) });
    }
  }
  return messages.slice(-16);
}

function compactSource(response: Answered): string {
  const parts = [`Parcels from snapshot ${response.source.parcelRunId}`];
  if (response.source.permitRunId) parts.push(`permits from ${response.source.permitRunId}`);
  return `${parts.join('; ')}.`;
}
