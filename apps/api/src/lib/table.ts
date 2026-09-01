import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { HEALTH_PROBE_KEY, runKey } from '@oracle-seminole/shared';
import { tracer } from '../observability';

export const TABLE_NAME = process.env.TABLE_NAME ?? '';

const documentClient = DynamoDBDocumentClient.from(
  tracer.captureAWSv3Client(new DynamoDBClient({})),
);

/**
 * Cheapest possible proof that the table exists and the Lambda's IAM grant works.
 * A miss on the sentinel key is a successful probe — DynamoDB answered.
 */
export async function probeTable(): Promise<boolean> {
  await documentClient.send(new GetCommand({ TableName: TABLE_NAME, Key: HEALTH_PROBE_KEY }));
  return true;
}

/** Reads one run's metadata item. Returns `null` when the run has not been recorded. */
export async function getRun(runId: string): Promise<Record<string, unknown> | null> {
  const response = await documentClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: runKey(runId) }),
  );
  return response.Item ?? null;
}
