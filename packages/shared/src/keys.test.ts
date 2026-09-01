import { describe, expect, it } from 'vitest';
import {
  artifactCidKey,
  eligibilityKey,
  parcelPartition,
  parcelPermitKey,
  parcelStatusKey,
  runKey,
  sourceKey,
} from './keys';

describe('single-table keys', () => {
  it('builds every Phase 0 access pattern', () => {
    expect(runKey('2026-09-01T00')).toEqual({ PK: 'RUN#2026-09-01T00', SK: 'META' });
    expect(sourceKey('seminole-appraiser')).toEqual({
      PK: 'SOURCE#seminole-appraiser',
      SK: 'META',
    });
    expect(parcelStatusKey('01-20-30-5AA-0000-0010', 'appraisal')).toEqual({
      PK: 'PARCEL#01-20-30-5AA-0000-0010',
      SK: 'STATUS#appraisal',
    });
    expect(parcelPermitKey('01-20-30-5AA-0000-0010', 'BR21-000123')).toEqual({
      PK: 'PARCEL#01-20-30-5AA-0000-0010',
      SK: 'PERMIT#BR21-000123',
    });
    expect(eligibilityKey('run-7', 'parcel-9')).toEqual({
      PK: 'ELIG#run-7',
      SK: 'PARCEL#parcel-9',
    });
    expect(artifactCidKey('run-7', 'query-table')).toEqual({
      PK: 'CID#run-7',
      SK: 'query-table',
    });
  });

  it('co-locates a parcel status row and its permit rows in one partition', () => {
    const parcelId = '01-20-30-5AA-0000-0010';
    expect(parcelStatusKey(parcelId, 'permits').PK).toBe(parcelPartition(parcelId));
    expect(parcelPermitKey(parcelId, 'BR21-000123').PK).toBe(parcelPartition(parcelId));
  });

  it('sorts a parcel\u2019s status rows before its permit rows', () => {
    const status = parcelStatusKey('p', 'seeded').SK;
    const permit = parcelPermitKey('p', 'A1').SK;
    expect(permit < status).toBe(true);
  });
});
