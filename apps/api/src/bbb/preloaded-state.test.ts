/**
 * Parser tests against two real captures.
 *
 * Both fixtures are unmodified responses from 2026-09-01, kept whole rather than trimmed:
 * the payload is one ~100 KB line and the false-positive markers that produced the earlier
 * "BBB is bot-protected" conclusion only exist in the full document.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cityFromReportUrl,
  MissingResultPayloadError,
  parseSearchPayload,
  sliceStateLiteral,
  stripHighlightTags,
} from './preloaded-state';
import { toBusinessRecord } from './search';

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8');
}

const categoryPage = fixture('bbb-search-category.html');
const namePage = fixture('bbb-search-name.html');

describe('parseSearchPayload', () => {
  it('reads a full page of results out of a category search', () => {
    const payload = parseSearchPayload(categoryPage);
    expect(payload.results).toHaveLength(15);
    expect(payload.pageSize).toBe(15);
    expect(payload.page).toBe(1);
  });

  it('reports the endpoint page ceiling alongside a much larger total', () => {
    const payload = parseSearchPayload(categoryPage);
    // The coverage limit this tier is built around: 15 pages regardless of the total.
    expect(payload.totalPages).toBe(15);
    expect(payload.totalResults ?? 0).toBeGreaterThan(1_000);
  });

  it('does not mistake the always-present Cloudflare bootstrap for a challenge', () => {
    // Both markers are in a successful response. Grepping for them is what misled the
    // earlier feasibility check, so the fixtures are asserted to contain them.
    expect(categoryPage).toContain('challenge-platform');
    expect(categoryPage.toLowerCase()).toContain('captcha');
    expect(() => parseSearchPayload(categoryPage)).not.toThrow();
  });

  it('throws when a response carries no payload', () => {
    expect(() => parseSearchPayload('<html><body>nothing here</body></html>')).toThrow(
      MissingResultPayloadError,
    );
  });

  it('throws rather than returning partial data when the literal is unparseable', () => {
    expect(() => parseSearchPayload('window.__PRELOADED_STATE__ = {"searchResult":')).toThrow(
      MissingResultPayloadError,
    );
  });
});

describe('sliceStateLiteral', () => {
  it('finds the closing brace of a deeply nested one-line payload', () => {
    const literal = sliceStateLiteral(categoryPage);
    expect(literal).not.toBeNull();
    expect(() => JSON.parse(literal as string)).not.toThrow();
  });

  it('is not confused by braces inside string values', () => {
    const html = 'window.__PRELOADED_STATE__ = {"a":"} not the end \\" also not","b":1};';
    expect(JSON.parse(sliceStateLiteral(html) as string)).toEqual({
      a: '} not the end " also not',
      b: 1,
    });
  });
});

describe('stripHighlightTags', () => {
  it('removes the em tags BBB wraps around the matched term', () => {
    expect(stripHighlightTags('<em>JTO</em> <em>Roofing</em> and Solar')).toBe(
      'JTO Roofing and Solar',
    );
  });

  it('leaves an unhighlighted name alone', () => {
    expect(stripHighlightTags('Collis Roofing, Inc.')).toBe('Collis Roofing, Inc.');
  });

  it('strips highlights from a real name-search response', () => {
    const payload = parseSearchPayload(namePage);
    const names = payload.results.map((result) =>
      stripHighlightTags(String((result as { businessName?: unknown }).businessName)),
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).not.toContain('<em>');
  });
});

describe('cityFromReportUrl', () => {
  it('takes the business city from the profile path', () => {
    expect(
      cityFromReportUrl('/us/fl/sanford/profile/roofing-contractors/jto-roofing-and-solar-0733-90331200'),
    ).toEqual({ city: 'Sanford', state: 'FL' });
  });

  it('title-cases a multi-word city slug', () => {
    expect(cityFromReportUrl('/us/fl/winter-park/profile/roofing-contractors/x-1-2').city).toBe(
      'Winter Park',
    );
  });

  it('returns nulls rather than guessing on an unexpected path', () => {
    expect(cityFromReportUrl('/ca/on/toronto/profile/x')).toEqual({ city: null, state: null });
    expect(cityFromReportUrl('/us/fl')).toEqual({ city: null, state: null });
  });
});

describe('toBusinessRecord', () => {
  const context = {
    sourceUrl: 'https://www.bbb.org/search?find_text=test',
    fetchedAt: '2026-09-01T12:00:00.000Z',
    rawKey: 'raw/bbb/search/x/page-0001.html',
    query: { term: 'test', location: 'Sanford, FL', kind: 'city_seed' as const, page: 1 },
  };

  it('prefers the profile-path city over the payload city', () => {
    const record = toBusinessRecord(
      {
        id: '0733_1_2',
        businessId: '1',
        businessName: 'Example Roofing',
        // The requester's geolocation, which the payload also carries.
        city: 'Ashburn',
        state: 'VA',
        reportUrl: '/us/fl/oviedo/profile/roofing-contractors/example-roofing-0733-1',
      },
      context,
    );
    expect(record?.city).toBe('Oviedo');
    expect(record?.state).toBe('FL');
    // Retained, so a disagreement stays visible rather than being erased.
    expect(record?.payloadCity).toBe('Ashburn');
  });

  it('carries provenance on every record', () => {
    const record = toBusinessRecord(
      { id: '0733_1_2', businessId: '1', businessName: 'Example Roofing' },
      context,
    );
    expect(record?.sourceUrl).toBe(context.sourceUrl);
    expect(record?.fetchedAt).toBe(context.fetchedAt);
    expect(record?.rawKey).toBe(context.rawKey);
  });

  it('keeps only recognised letter grades', () => {
    const rated = toBusinessRecord(
      { id: 'a', businessId: '1', businessName: 'X', rating: 'A+' },
      context,
    );
    const bogus = toBusinessRecord(
      { id: 'b', businessId: '2', businessName: 'Y', rating: 'excellent' },
      context,
    );
    expect(rated?.rating).toBe('A+');
    expect(bogus?.rating).toBeNull();
  });

  it('flags roofing from the category family rather than the search term', () => {
    const record = toBusinessRecord(
      {
        id: 'a',
        businessId: '1',
        businessName: 'X',
        categories: [{ id: '10126-200', name: 'Commercial Roofing' }],
        tobText: 'Awnings',
      },
      context,
    );
    expect(record?.roofing).toBe(true);
  });

  it('drops a result with no usable identity', () => {
    expect(toBusinessRecord({ businessName: 'No id here' }, context)).toBeNull();
    expect(toBusinessRecord({ id: 'a', businessId: '1' }, context)).toBeNull();
  });

  it('maps every result in a real response', () => {
    const payload = parseSearchPayload(categoryPage);
    const records = payload.results.flatMap((raw) => {
      const record = toBusinessRecord(raw, context);
      return record ? [record] : [];
    });
    expect(records).toHaveLength(15);
    for (const record of records) {
      expect(record.businessName.length).toBeGreaterThan(0);
      expect(record.fetchedAt).toBe(context.fetchedAt);
    }
  });
});
