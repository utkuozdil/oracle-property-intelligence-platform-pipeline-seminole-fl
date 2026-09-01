/**
 * The per-permit terminal-status ledger.
 *
 * Deliberately a skip guard and nothing more. Idempotency for this tier lives at the
 * Distributed Map level — built-in redrive plus retries on the states inside each item
 * processor — because that is where a partial run is actually resumed. This table only
 * answers one question, and answers it cheaply: has this permit already reached a state
 * that can never change?
 *
 * That question is worth a table because Source B is the expensive source at ~2.3 s per
 * permit, and over a 30-year census the overwhelming majority of permits are terminal. A
 * permit reading `PERMIT COMPLETE`, `CLOSED`, `VOIDED`, or either certificate is immutable
 * and is never fetched again.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { logger } from '../observability';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/**
 * Keys live in their own partition rather than under `PARCEL#<id>`.
 *
 * A permit's terminal status is known from Source B before its parcel has necessarily been
 * reconciled, and `PARCEL#<id>` / `PERMIT#<appNo>` is the reconciliation tier's vocabulary.
 * Writing this guard there would have two owners writing one item.
 */
export function permitLedgerKey(appNo: string): { PK: string; SK: string } {
  return { PK: `PERMITSTATUS#${appNo}`, SK: 'META' };
}

export interface LedgerEntry {
  appNo: string;
  rawStatus: string;
  canonicalStatus: string;
  terminal: boolean;
  closedDate: string | null;
  lastHarvestedAt: string;
  runId: string;
}

function tableName(): string {
  const name = process.env.TABLE_NAME;
  if (!name) throw new Error('TABLE_NAME is not set');
  return name;
}

/** DynamoDB caps `BatchGetItem` at 100 keys and `BatchWriteItem` at 25 items. */
const BATCH_GET_LIMIT = 100;
const BATCH_WRITE_LIMIT = 25;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * The subset of `appNos` already known to be terminal.
 *
 * A read failure returns an empty set rather than throwing: the worst outcome of a lost
 * skip is re-fetching a permit that did not need it, and that is much cheaper than failing
 * a shard over a cache miss.
 */
export async function terminalPermits(appNos: readonly string[]): Promise<Set<string>> {
  if (appNos.length === 0) return new Set();
  const terminal = new Set<string>();
  const table = tableName();

  for (const keys of chunk([...new Set(appNos)], BATCH_GET_LIMIT)) {
    try {
      const response = await client.send(
        new BatchGetCommand({
          RequestItems: {
            [table]: {
              Keys: keys.map(permitLedgerKey),
              ProjectionExpression: 'appNo, terminal',
            },
          },
        }),
      );
      for (const item of response.Responses?.[table] ?? []) {
        const entry = item as Partial<LedgerEntry>;
        if (entry.terminal === true && entry.appNo) terminal.add(entry.appNo);
      }
    } catch (error) {
      logger.warn('Terminal-permit ledger read failed; re-harvesting this chunk', {
        keys: keys.length,
        error,
      });
    }
  }
  return terminal;
}

/**
 * When each of `appNos` was last harvested, for those the ledger has seen at all.
 *
 * Separate from {@link terminalPermits} because the two answer different questions and only one
 * of them is permanent. Terminal means "never ask again"; this means "asked recently", which is
 * what lets a sweep run in tranches without the next tranche re-fetching the previous one's
 * still-open permits. Ordering the sweep oldest-first makes that failure mode acute rather than
 * theoretical: open permits concentrate at the old end, so they are exactly what a resumed run
 * would meet first.
 *
 * Like the terminal read, a failure returns nothing rather than throwing: the cost of a lost
 * skip is one redundant fetch.
 */
export async function observedPermits(appNos: readonly string[]): Promise<Map<string, string>> {
  if (appNos.length === 0) return new Map();
  const observed = new Map<string, string>();
  const table = tableName();

  for (const keys of chunk([...new Set(appNos)], BATCH_GET_LIMIT)) {
    try {
      const response = await client.send(
        new BatchGetCommand({
          RequestItems: {
            [table]: {
              Keys: keys.map(permitLedgerKey),
              ProjectionExpression: 'appNo, lastHarvestedAt',
            },
          },
        }),
      );
      for (const item of response.Responses?.[table] ?? []) {
        const entry = item as Partial<LedgerEntry>;
        if (entry.appNo && entry.lastHarvestedAt) observed.set(entry.appNo, entry.lastHarvestedAt);
      }
    } catch (error) {
      logger.warn('Observed-permit ledger read failed; re-harvesting this chunk', {
        keys: keys.length,
        error,
      });
    }
  }
  return observed;
}

/**
 * One item that says the roofing worklist index is current.
 *
 * The 73k application rows live in S3 (`roofing-candidates.ndjson`); this record is the
 * cheap "do we already have an index for this census?" check so a later plan does not walk
 * 368 month files again. Status itself stays on {@link permitLedgerKey}.
 */
export function candidateIndexPointerKey(): { PK: string; SK: string } {
  return { PK: 'PERMITCANDIDATES', SK: 'ROOFING' };
}

export interface CandidateIndexPointer {
  fingerprint: string;
  count: number;
  allApplications: number;
  builtAt: string;
  rowsKey: string;
}

export async function readCandidateIndexPointer(): Promise<CandidateIndexPointer | null> {
  try {
    const response = await client.send(
      new GetCommand({
        TableName: tableName(),
        Key: candidateIndexPointerKey(),
        ProjectionExpression: 'fingerprint, #count, allApplications, builtAt, rowsKey',
        ExpressionAttributeNames: { '#count': 'count' },
      }),
    );
    const item = response.Item as Partial<CandidateIndexPointer> | undefined;
    if (!item?.fingerprint || item.count === undefined || !item.builtAt || !item.rowsKey) {
      return null;
    }
    return {
      fingerprint: item.fingerprint,
      count: item.count,
      allApplications: item.allApplications ?? item.count,
      builtAt: item.builtAt,
      rowsKey: item.rowsKey,
    };
  } catch (error) {
    logger.warn('Candidate-index pointer read failed; will consult S3 meta', { error });
    return null;
  }
}

export async function recordCandidateIndexPointer(pointer: CandidateIndexPointer): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: tableName(),
      Item: { ...candidateIndexPointerKey(), ...pointer },
    }),
  );
}

/** Records what each permit's status was, so a terminal one is never fetched twice. */
export async function recordPermitStatuses(entries: readonly LedgerEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const table = tableName();
  for (const batch of chunk(entries, BATCH_WRITE_LIMIT)) {
    await client.send(
      new BatchWriteCommand({
        RequestItems: {
          [table]: batch.map((entry) => ({
            PutRequest: { Item: { ...permitLedgerKey(entry.appNo), ...entry } },
          })),
        },
      }),
    );
  }
}
