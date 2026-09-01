import { describe, expect, it } from 'vitest';
import { DATA_PREFIXES, rawCaptureKey, runManifestKey } from './storage';

describe('data bucket layout', () => {
  it('provisions exactly the four Phase 0 prefixes', () => {
    expect(Object.values(DATA_PREFIXES)).toEqual(['raw/', 'staged/', 'publish/', 'manifests/']);
  });

  it('scopes every object key to a run so runs never overwrite each other', () => {
    expect(runManifestKey('run-7')).toBe('manifests/run-7/manifest.json');
    expect(rawCaptureKey('run-7', 'appraiser', 'parcel-9')).toBe(
      'raw/run-7/appraiser/parcel-9.json',
    );
  });
});
