import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const IPNS = 'k51qzi5uqu5di4rwv9bhnuzrg6xrxsugpjq8y85zhsgethars962cmosaqbh8i';

describe('loadConfig', () => {
  it('needs no environment at all to reach the published data', () => {
    const config = loadConfig({});
    expect(config.ipnsName).toBe(IPNS);
    // The trap that already cost a day: the dataset CID is a directory, and DuckDB
    // reports a directory as "No magic bytes found". The path must reach the file.
    expect(config.parquetSource).toBe(`https://ipfs.io/ipns/${IPNS}/query-table/seminole.parquet`);
    expect(config.enrichment.permitStatusUri).toBeNull();
    expect(config.enrichment.bbbPointerUri).toBeNull();
  });

  it('resolves through IPNS rather than a pinned CID, so a re-publish needs no change here', () => {
    expect(loadConfig({}).parquetSource).toContain('/ipns/');
    expect(loadConfig({}).manifestUrl).toContain('/ipns/');
  });

  it('honours an alternate IPNS name and gateway, trailing slash or not', () => {
    const config = loadConfig({
      ORACLE_OPEN_DATA_IPNS: 'k51other',
      ORACLE_OPEN_DATA_GATEWAY: 'https://dweb.link/',
    });
    expect(config.parquetSource).toBe(
      'https://dweb.link/ipns/k51other/query-table/seminole.parquet',
    );
  });

  it('takes a local Parquet override and records that IPNS is out of the path', () => {
    const config = loadConfig({ ORACLE_MCP_PARQUET_URL: '/tmp/seminole.parquet' });
    expect(config.parquetSource).toBe('/tmp/seminole.parquet');
    expect(config.parquetOverridden).toBe(true);
  });

  it('treats an empty enrichment variable as unset rather than as an empty path', () => {
    const config = loadConfig({ ORACLE_PERMIT_STATUS_URI: '  ' });
    expect(config.enrichment.permitStatusUri).toBeNull();
  });

  it('can turn the cache off', () => {
    expect(loadConfig({ ORACLE_MCP_CACHE_DIR: 'off' }).cacheDir).toBeNull();
    expect(loadConfig({ ORACLE_MCP_CACHE_DIR: '/tmp/cache' }).cacheDir).toBe('/tmp/cache');
  });
});
