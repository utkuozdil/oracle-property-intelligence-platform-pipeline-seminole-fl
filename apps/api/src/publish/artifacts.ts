import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { artifactCidKey, COUNTY, type ArtifactType } from '@oracle-seminole/shared';
import type { IpfsPublicationRecord } from './pointer';

/**
 * Records the published CIDs where the serving tier already expects to find them.
 *
 * `CID#<runId>` / `<artifactType>` is a key shape the table was designed with in Phase 0
 * — it is not invented here. Writing the CIDs into it means the UI reads artifact
 * references from the same table it already reads run history from, with one `Query` on
 * one partition, rather than fetching an object out of S3 on a page render.
 *
 * `ARTIFACT_TYPES` has three members and this publish produces four datasets, so the
 * geo index has no slot of its own. Rather than widen a shared type from here, the
 * `run-manifest` item carries the complete dataset map — including the geo index — and
 * the two dataset items carry the artifact a consumer is most likely to want directly.
 */

const ARTIFACT_FOR_DATASET: Record<string, ArtifactType> = {
  'query-table': 'query-table',
  'open-data': 'property-index',
};

export interface ArtifactItem {
  PK: string;
  SK: string;
  county: string;
  runId: string;
  artifactType: ArtifactType;
  cid: string;
  path: string | null;
  url: string;
  ipnsName: string;
  ipnsSequence: number;
  rootCid: string;
  bytes: number;
  coverage: string;
  publishedAt: string;
  gateway: string;
  datasets?: IpfsPublicationRecord['datasets'];
}

export function artifactItems(record: IpfsPublicationRecord): ArtifactItem[] {
  const shared = {
    county: COUNTY,
    runId: record.runId,
    ipnsName: record.ipns.name,
    ipnsSequence: record.ipns.sequence,
    rootCid: record.rootCid,
    publishedAt: record.publishedAt,
    gateway: record.verification.gateway,
  };

  const items: ArtifactItem[] = Object.entries(record.datasets)
    .filter(([dataset]) => dataset in ARTIFACT_FOR_DATASET)
    .map(([dataset, published]) => {
      const artifactType = ARTIFACT_FOR_DATASET[dataset] as ArtifactType;
      return {
        ...artifactCidKey(record.runId, artifactType),
        ...shared,
        artifactType,
        cid: published.cid,
        path: published.entryPath,
        url: published.url,
        bytes: published.bytes,
        coverage: published.coverage,
      };
    });

  items.push({
    ...artifactCidKey(record.runId, 'run-manifest'),
    ...shared,
    artifactType: 'run-manifest',
    cid: record.rootCid,
    path: null,
    url: record.ipns.url,
    bytes: record.totals.bytes,
    coverage: 'county root — one IPNS name over every published dataset',
    datasets: record.datasets,
  });

  return items;
}

export async function recordArtifactCids(
  tableName: string,
  record: IpfsPublicationRecord,
): Promise<number> {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  const items = artifactItems(record);
  for (const item of items) {
    await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
  }
  return items.length;
}
