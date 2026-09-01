import { describe, expect, it } from 'vitest';
import { parseAgentQuestion } from './agent-parse';

describe('parseAgentQuestion', () => {
  it('parses the aged-roof demo prompt', () => {
    const result = parseAgentQuestion(
      'Which properties in Seminole County within five miles of Sanford have roofs older than 15 years?',
    );
    expect(result.status).toBe('parsed');
    if (result.status !== 'parsed') return;
    expect(result.draft.near).toBe('Sanford');
    expect(result.draft.radiusMiles).toBe(5); // "five miles", not only "5 miles"
    expect(result.draft.roofAgeMin).toBe(15);
    expect(result.draft.openRoofingOnly).toBe(false);
    expect(result.draft.useCurrentArea).toBe(false);
  });

  it('parses the open-permit contractor demo prompt against the current area', () => {
    const result = parseAgentQuestion(
      'Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?',
    );
    expect(result.status).toBe('parsed');
    if (result.status !== 'parsed') return;
    expect(result.draft.useCurrentArea).toBe(true);
    expect(result.draft.openRoofingOnly).toBe(true);
    expect(result.draft.minOpenRoofingYears).toBe(3);
    expect(result.draft.sort).toBe('permit_open_desc');
    expect(result.draft.notes.some((note) => note.includes('contractor'))).toBe(true);
    expect(result.draft.notes.some((note) => /unknown/i.test(note))).toBe(true);
  });

  it('refuses a question that is not about property data', () => {
    const result = parseAgentQuestion('Write a haiku about Orlando');
    expect(result.status).toBe('refused');
  });

  it('reads a same-query follow-up that adds open permits', () => {
    const result = parseAgentQuestion('What about same query with open permits only');
    expect(result.status).toBe('parsed');
    if (result.status !== 'parsed') return;
    expect(result.draft.useCurrentArea).toBe(true);
    expect(result.draft.keepPriorFilters).toBe(true);
    expect(result.draft.openRoofingOnly).toBe(true);
  });

  it('treats “roofs” as a property question and names an out-of-county city', () => {
    const result = parseAgentQuestion('roofs 10 year near ödemiş');
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toMatch(/ödemiş/i);
    expect(result.reason).toMatch(/Seminole/i);
  });
});
