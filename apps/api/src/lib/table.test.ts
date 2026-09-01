import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRun, probeTable } from './table';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

afterEach(() => {
  ddbMock.reset();
});

describe('probeTable', () => {
  it('treats a sentinel-key miss as a reachable table', async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(probeTable()).resolves.toBe(true);
  });

  it('propagates DynamoDB failures so readiness can report them', async () => {
    ddbMock.on(GetCommand).rejects(new Error('ResourceNotFoundException'));
    await expect(probeTable()).rejects.toThrow('ResourceNotFoundException');
  });
});

describe('getRun', () => {
  it('reads the RUN#<runId> / META item', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { PK: 'RUN#run-7', SK: 'META', county: 'Seminole' } });

    await expect(getRun('run-7')).resolves.toEqual({
      PK: 'RUN#run-7',
      SK: 'META',
      county: 'Seminole',
    });

    const input = ddbMock.commandCalls(GetCommand)[0]?.args[0].input;
    expect(input?.Key).toEqual({ PK: 'RUN#run-7', SK: 'META' });
  });

  it('returns null for an unrecorded run rather than throwing', async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(getRun('missing')).resolves.toBeNull();
  });
});
