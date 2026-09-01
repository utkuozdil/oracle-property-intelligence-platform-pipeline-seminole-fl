import { describe, expect, it } from 'vitest';
import {
  FilterError,
  ORDER_BY,
  SUMMARY_COLUMNS,
  boundingBox,
  buildPredicates,
  haversineMiles,
  whereClause,
} from './filters';

describe('buildPredicates', () => {
  it('emits nothing for an empty filter set', () => {
    expect(buildPredicates({})).toEqual([]);
    expect(whereClause([])).toBe('');
  });

  it('maps every filter onto a published column', () => {
    const predicates = buildPredicates({
      minRoofAge: 15,
      maxRoofAge: 40,
      jurisdiction: 'Sanford',
      ownerOutOfArea: true,
      hasPool: false,
      soldBefore: '2015-01-01',
    });

    expect(predicates).toContain('roof_age >= 15');
    expect(predicates).toContain('roof_age <= 40');
    expect(predicates).toContain("jurisdiction ILIKE '%Sanford%'");
    expect(predicates).toContain('owner_out_of_area = TRUE');
    expect(predicates).toContain('has_pool = FALSE');
    expect(predicates).toContain("last_sale_date < DATE '2015-01-01'");
  });

  it('escapes quotes in text filters rather than letting them close the literal', () => {
    const [predicate] = buildPredicates({ ownerNameContains: "O'BRIEN" });
    expect(predicate).toBe("owner_name ILIKE '%O''BRIEN%'");
  });

  it('rejects a non-ISO date instead of passing it to the engine', () => {
    expect(() => buildPredicates({ soldAfter: "2020-01-01'; DROP" })).toThrow(FilterError);
  });

  it('rejects a non-finite number', () => {
    expect(() => buildPredicates({ minJustValue: Number.NaN })).toThrow(FilterError);
  });
});

describe('haversineMiles', () => {
  it('inlines the pin as numeric literals', () => {
    const expression = haversineMiles(28.8117, -81.2734);
    expect(expression).toContain('28.8117');
    expect(expression).toContain('-81.2734');
    expect(expression).toContain('3958.8');
  });

  it('refuses a non-finite coordinate', () => {
    expect(() => haversineMiles(Number.POSITIVE_INFINITY, 0)).toThrow(FilterError);
  });
});

describe('boundingBox', () => {
  it('produces two sargable range predicates for row-group pruning', () => {
    const [latitude, longitude] = boundingBox(28.8117, -81.2734, 5);
    expect(latitude).toMatch(/^latitude BETWEEN /);
    expect(longitude).toMatch(/^longitude BETWEEN /);
  });

  it('keeps the longitude delta finite at the pole', () => {
    const [, longitude] = boundingBox(90, 0, 5);
    expect(longitude).toContain('greatest(cos(radians(90)), 0.01)');
  });
});

describe('the tool surface', () => {
  it('orders by columns that exist in the summary projection', () => {
    const summary = new Set<string>(SUMMARY_COLUMNS);
    for (const clause of Object.values(ORDER_BY)) {
      const column = clause.split(' ')[0] ?? '';
      expect(summary.has(column)).toBe(true);
    }
  });
});
