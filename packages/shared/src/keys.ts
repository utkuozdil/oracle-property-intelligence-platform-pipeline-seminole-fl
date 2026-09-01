/**
 * Single-table DynamoDB key vocabulary for the Seminole County pipeline.
 *
 * Access patterns provisioned in Phase 0:
 *   PK=RUN#<runId>     SK=META               — one ingestion run's metadata
 *   PK=SOURCE#<name>   SK=META               — a data source and its constraints
 *   PK=PARCEL#<id>     SK=STATUS#<stage>     — a parcel's progress through a stage
 *   PK=PARCEL#<id>     SK=PERMIT#<appNo>     — a permit attached to a parcel
 *   PK=ELIG#<runId>    SK=PARCEL#<id>        — parcels eligible for publication in a run
 *   PK=CID#<runId>     SK=<artifactType>     — the IPFS CID of a published artifact
 *
 * `SYSTEM#HEALTH` is a reserved partition used only by the API readiness probe.
 */

export interface TableKey {
  PK: string;
  SK: string;
}

/** Stages a parcel passes through. Used as the `STATUS#<stage>` discriminator. */
export const PARCEL_STAGES = ['seeded', 'appraisal', 'permits', 'reconciled', 'published'] as const;

export type ParcelStage = (typeof PARCEL_STAGES)[number];

/** Artifact kinds published per run. Used as the `CID#<runId>` sort key. */
export const ARTIFACT_TYPES = ['property-index', 'query-table', 'run-manifest'] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export function runKey(runId: string): TableKey {
  return { PK: `RUN#${runId}`, SK: 'META' };
}

export function sourceKey(sourceName: string): TableKey {
  return { PK: `SOURCE#${sourceName}`, SK: 'META' };
}

export function parcelStatusKey(parcelId: string, stage: ParcelStage): TableKey {
  return { PK: `PARCEL#${parcelId}`, SK: `STATUS#${stage}` };
}

export function parcelPermitKey(parcelId: string, applicationNumber: string): TableKey {
  return { PK: `PARCEL#${parcelId}`, SK: `PERMIT#${applicationNumber}` };
}

export function eligibilityKey(runId: string, parcelId: string): TableKey {
  return { PK: `ELIG#${runId}`, SK: `PARCEL#${parcelId}` };
}

export function artifactCidKey(runId: string, artifactType: ArtifactType): TableKey {
  return { PK: `CID#${runId}`, SK: artifactType };
}

/** Every item for one parcel — both status rows and permit rows — sorts under this PK. */
export function parcelPartition(parcelId: string): string {
  return `PARCEL#${parcelId}`;
}

export const HEALTH_PROBE_KEY: TableKey = {
  PK: 'SYSTEM#HEALTH',
  SK: 'META',
};
