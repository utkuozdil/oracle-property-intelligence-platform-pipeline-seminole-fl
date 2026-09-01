import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { tracer } from '../observability';

/**
 * Per-snapshot idempotency ledger for the source archive.
 *
 * One row per source ETag under the existing `SOURCE#<name>` partition:
 *
 *     PK=SOURCE#seminole-cama   SK=SNAPSHOT#<etag>
 *
 * The row is written `PENDING` when the archive is stored and flipped to `COMPLETED`
 * only when the transform has finished and its output is durable. `FetchRoll` skips a
 * download only on `COMPLETED`, so a run that dies mid-transform leaves a `PENDING` row
 * that does not suppress the retry — the ledger can delay work but never lose it.
 *
 * The `COMPLETED` transition is a conditional write, so two executions that somehow
 * both reach the end of the same snapshot cannot both claim it.
 */

const client = DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE_NAME = process.env.TABLE_NAME ?? '';

export type SnapshotStatus = 'PENDING' | 'COMPLETED';

const SourceSnapshot = z.object({
  status: z.enum(['PENDING', 'COMPLETED']),
  runId: z.string().min(1),
  fingerprint: z.string(),
  contentLength: z.number().int().nonnegative(),
  lastModified: z.string(),
  parcelCount: z.number().int().nonnegative().optional(),
  completedAt: z.string().optional(),
});

export type SourceSnapshot = z.infer<typeof SourceSnapshot>;

function snapshotKey(sourceName: string, etag: string): { PK: string; SK: string } {
  return { PK: `SOURCE#${sourceName}`, SK: `SNAPSHOT#${normalizeEtag(etag)}` };
}

/**
 * Strip the quoting and any weak-validator prefix an ETag arrives with.
 *
 * The source returns IIS-style quoted ETags, and `"abc"` and `abc` must not become two
 * ledger rows for one snapshot — that would silently disable the skip.
 */
export function normalizeEtag(etag: string): string {
  return etag.replace(/^W\//, '').replace(/^"|"$/g, '');
}

export async function getSourceSnapshot(
  sourceName: string,
  etag: string,
): Promise<SourceSnapshot | null> {
  if (!etag) return null;

  const { Item } = await client.send(
    new GetCommand({ TableName: TABLE_NAME, Key: snapshotKey(sourceName, etag) }),
  );
  if (!Item) return null;

  // A malformed ledger row must not be read as "already completed" — that would skip
  // ingestion forever. Parsing loosely and failing closed is the safe direction.
  const parsed = SourceSnapshot.safeParse(Item);
  return parsed.success ? parsed.data : null;
}

export type ClaimResult = 'CLAIMED' | 'ALREADY_COMPLETED';

export async function putSourceSnapshotPending(
  sourceName: string,
  etag: string,
  details: {
    runId: string;
    fingerprint: string;
    contentLength: number;
    lastModified: string;
    /**
     * Reopen a snapshot the ledger has already completed.
     *
     * Without this, `force` is only half a bypass: it skips the read check but still
     * trips the write condition below, so re-running an unchanged source is impossible.
     * That matters because re-running unchanged bytes is exactly what a transform change
     * requires — the source has not moved, but the output must.
     */
    force?: boolean;
  },
): Promise<ClaimResult> {
  if (!etag) return 'CLAIMED';

  /**
   * Never downgrade a COMPLETED row back to PENDING, so an ordinary re-run cannot reopen
   * a closed snapshot. An operator-initiated `force` is the one thing allowed to.
   *
   * The `:completed` placeholder has to disappear with the condition that references it,
   * because DynamoDB rejects any `ExpressionAttributeValues` entry left unused.
   */
  const condition = details.force
    ? undefined
    : 'attribute_not_exists(#status) OR #status <> :completed';

  const values: Record<string, unknown> = {
    ':pending': 'PENDING',
    ':runId': details.runId,
    ':fingerprint': details.fingerprint,
    ':contentLength': details.contentLength,
    ':lastModified': details.lastModified,
    ':now': new Date().toISOString(),
  };
  if (condition) values[':completed'] = 'COMPLETED';

  try {
    await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: snapshotKey(sourceName, etag),
        UpdateExpression:
          'SET #status = :pending, runId = :runId, fingerprint = :fingerprint, ' +
          'contentLength = :contentLength, lastModified = :lastModified, claimedAt = :now',
        ConditionExpression: condition,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: values,
      }),
    );
    return 'CLAIMED';
  } catch (error) {
    // Losing this condition means another execution completed the same snapshot between
    // our read and our write. That is the guard doing its job, not a fault, so it stands
    // down quietly rather than failing the workflow and paging someone.
    if (error instanceof ConditionalCheckFailedException) return 'ALREADY_COMPLETED';
    throw error;
  }
}

export async function completeSourceSnapshot(
  sourceName: string,
  etag: string,
  details: { runId: string; parcelCount: number },
): Promise<void> {
  if (!etag) return;

  await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: snapshotKey(sourceName, etag),
      UpdateExpression:
        'SET #status = :completed, parcelCount = :parcelCount, completedAt = :now, runId = :runId',
      // Idempotent by construction: the second attempt for the same snapshot fails the
      // condition and is treated by the caller as an accepted no-op.
      ConditionExpression: 'attribute_not_exists(#status) OR #status <> :completed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':completed': 'COMPLETED',
        ':parcelCount': details.parcelCount,
        ':runId': details.runId,
        ':now': new Date().toISOString(),
      },
    }),
  );
}
