import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artifactItems } from './artifacts';
import { packRootDirectory, type RootChild } from './car';
import { ipnsAuthorization } from './config';
import { selectShards } from './datasets';
import type { IpfsPublicationRecord } from './pointer';

/**
 * The published generation, kept as a fixture.
 *
 * These are the CIDs and sizes of the live publication at
 * `/ipns/k51qzi5uqu5di4rwv9bhnuzrg6xrxsugpjq8y85zhsgethars962cmosaqbh8i`, and Filebase
 * independently reported each one back on import.
 */
const PUBLISHED_CHILDREN: RootChild[] = [
  {
    name: 'geo-index',
    cid: 'bafybeichx6h3oea7qrvlpmeiewy5e6bd65ulmz5ankw5pndk3b7c6cvoy4',
    tsize: 11144410,
  },
  {
    name: 'open-data',
    cid: 'bafybeifc7y3tihttooe56hxavakim7hyqd5all6uymergajzguyg32w6t4',
    tsize: 109765886,
  },
  {
    name: 'query-table',
    cid: 'bafybeidquqx7szwsc44coish3dpavvur5nnop4chcqan3ykcknxpfllr7y',
    tsize: 22042150,
  },
];

const PUBLISHED_ROOT = 'bafybeihqugxdqbqe3noi6niqxtzka2ouufk4xcspnkkwjjcbyxdvkx3sle';

describe('packRootDirectory', () => {
  const work = mkdtempSync(join(tmpdir(), 'publish-test-'));

  it('reproduces the root CID that Filebase pinned', async () => {
    const root = await packRootDirectory(PUBLISHED_CHILDREN, join(work, 'root.car'));
    expect(root).toBe(PUBLISHED_ROOT);
    rmSync(work, { recursive: true, force: true });
  });

  it('sorts links by name, so caller ordering cannot change the CID', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'publish-test-'));
    const reversed = [...PUBLISHED_CHILDREN].reverse();
    const root = await packRootDirectory(reversed, join(scratch, 'root.car'));
    expect(root).toBe(PUBLISHED_ROOT);
    rmSync(scratch, { recursive: true, force: true });
  });
});

describe('selectShards', () => {
  // Whatever does not fit is named as omitted rather than dropped, because a consumer
  // has to be able to tell a deliberate gap from missing data.
  const shards = [
    { geohash5: 'djn55', parcels: 9000, bytes: 12_000_000 },
    { geohash5: 'djn4v', parcels: 8000, bytes: 4_000_000 },
    { geohash5: 'djn5h', parcels: 7000, bytes: 12_000_000 },
    { geohash5: 'djn4y', parcels: 100, bytes: 100_000 },
  ];

  it('takes whole shards in order while they fit the budget', () => {
    const { selected, omitted } = selectShards(shards, 20_000_000);

    expect(selected.map((shard) => shard.geohash5)).toEqual(['djn55', 'djn4v', 'djn4y']);
    expect(omitted.map((shard) => shard.geohash5)).toEqual(['djn5h']);
  });

  // A shard that does not fit is skipped, not truncated, and a smaller one after it is
  // still taken — so the budget is filled without ever publishing half a neighbourhood.
  it('skips an oversized shard but keeps filling the budget', () => {
    const { selected } = selectShards(shards, 16_000_000);

    expect(selected.map((shard) => shard.geohash5)).toEqual(['djn55', 'djn4y']);
    expect(selected).toEqual(selected.filter((shard) => shards.includes(shard)));
  });

  it('publishes everything when the budget is not binding', () => {
    const { selected, omitted } = selectShards(shards, Infinity);

    expect(selected).toHaveLength(shards.length);
    expect(omitted).toHaveLength(0);
  });
});

describe('ipnsAuthorization', () => {
  it('derives the bearer token from the S3 key pair', () => {
    const header = ipnsAuthorization({ accessKeyId: 'KEY', secretAccessKey: 'SECRET' });
    expect(header).toBe(`Bearer ${Buffer.from('KEY:SECRET').toString('base64')}`);
  });
});

describe('artifactItems', () => {
  const record = {
    version: 1,
    runId: 'run-1',
    county: 'Seminole County, FL',
    provider: 'filebase',
    publishedAt: '2026-09-01T00:00:00.000Z',
    ipns: {
      label: 'oracle-seminole',
      name: 'k51abc',
      sequence: 3,
      url: 'https://ipfs.io/ipns/k51abc',
    },
    rootCid: 'bafyroot',
    rootUrl: 'https://ipfs.io/ipfs/bafyroot',
    datasets: {
      'query-table': dataset('bafyquery', 'query-table/seminole.parquet'),
      'geo-index': dataset('bafygeo', 'geo-index/geo.json'),
      'open-data': dataset('bafyopen', 'open-data/index.json'),
    },
    totals: { bytes: 10, files: 6, quotaBytes: 100, quotaUsedFraction: 0.1 },
    verification: {
      gateway: 'https://ipfs.io',
      checkedAt: '2026-09-01T00:00:00.000Z',
      checks: [],
      parquetRange: { status: 206, magic: 'PAR1' },
    },
    unchanged: false,
  } as IpfsPublicationRecord;

  it('writes one item per declared artifact type, all under one partition', () => {
    const items = artifactItems(record);

    expect(items.map((item) => item.SK).sort()).toEqual([
      'property-index',
      'query-table',
      'run-manifest',
    ]);
    expect(new Set(items.map((item) => item.PK))).toEqual(new Set(['CID#run-1']));
  });

  it('maps the per-property index onto property-index and the root onto run-manifest', () => {
    const items = artifactItems(record);
    const byType = new Map(items.map((item) => [item.SK, item]));

    expect(byType.get('property-index')?.cid).toBe('bafyopen');
    expect(byType.get('query-table')?.cid).toBe('bafyquery');
    expect(byType.get('run-manifest')?.cid).toBe('bafyroot');
  });

  // The geo index has no artifact type of its own, so it would be invisible to the UI if
  // the run-manifest item did not carry the full map.
  it('keeps the geo index reachable through the run-manifest item', () => {
    const runManifest = artifactItems(record).find((item) => item.SK === 'run-manifest');
    expect(runManifest?.datasets?.['geo-index']?.cid).toBe('bafygeo');
  });
});

function dataset(cid: string, entryPath: string) {
  return {
    cid,
    entryPath,
    url: `https://ipfs.io/ipns/k51abc/${entryPath}`,
    immutableUrl: `https://ipfs.io/ipfs/${cid}/${entryPath.split('/')[1]}`,
    bytes: 1,
    files: 2,
    coverage: 'full',
    carKey: `layout/${entryPath.split('/')[0]}.car`,
    carBytes: 2,
    uploaded: true,
    notes: {},
  };
}
