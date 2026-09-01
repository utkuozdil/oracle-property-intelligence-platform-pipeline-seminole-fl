/**
 * Parsing the licence-qualifier parenthetical.
 *
 * Every input string in this file is a verbatim permit contractor name from the real staged
 * census, not an invented example. The forms are messy because the source is.
 */
import { describe, expect, it } from 'vitest';
import {
  looksLikeIndividual,
  nameSurvivedTruncation,
  parseContractorName,
  parsePersonName,
  stripQualifier,
} from './qualifier';

/** The 29 licence-type prefixes present in the extract, abbreviated to those used here. */
const PREFIXES = new Set(['CCC', 'CGC', 'CBC', 'CRC', 'RC', 'QB', 'FRO']);

function parse(name: string) {
  return parseContractorName(name, PREFIXES);
}

describe('stripQualifier', () => {
  it('closes up a qualifier spliced into the middle of a word', () => {
    /**
     * `SOLAR ROOFING AND CONST(CCC)RU` is `...CONSTRU` interrupted by a licence code, not a
     * `CONST` token and an `RU` token. Replacing it with a space manufactures a meaningless
     * `CONST RU` that matches nothing; deleting it recovers the real prefix.
     */
    expect(stripQualifier('SOLAR ROOFING AND CONST(CCC)RU')).toBe('SOLAR ROOFING AND CONSTRU');
  });

  it('removes a balanced qualifier and an unclosed one', () => {
    expect(stripQualifier('JTO CONTRACTING INC (HOOD CCC)')).toBe('JTO CONTRACTING INC');
    expect(stripQualifier('COLLIS ROOFING INC (LANIER-CCC')).toBe('COLLIS ROOFING INC');
    expect(stripQualifier('NATIONS ROOF RESIDENTIAL LLC(B')).toBe('NATIONS ROOF RESIDENTIAL LLC');
  });

  it('leaves a name with no qualifier alone', () => {
    expect(stripQualifier('BRITE TOP ROOFING')).toBe('BRITE TOP ROOFING');
  });
});

describe('parseContractorName', () => {
  it('reads a surname and prefix hyphenated and cut by the 30-character column', () => {
    const parsed = parse('COLLIS ROOFING INC (LANIER-CCC');
    expect(parsed.businessPart).toBe('COLLIS ROOFING INC');
    expect(parsed.surname).toBe('LANIER');
    expect(parsed.licencePrefix).toBe('CCC');
    // `LANIER` is not the last token — `CCC` is — so the surname itself is complete.
    expect(parsed.surnameTruncated).toBe(false);
  });

  it('reads a surname and prefix separated by a space', () => {
    const parsed = parse('JTO CONTRACTING INC (HOOD CCC)');
    expect(parsed.surname).toBe('HOOD');
    expect(parsed.licencePrefix).toBe('CCC');
    expect(parsed.surnameTruncated).toBe(false);
  });

  it('reads a prefix-first parenthetical with no space before it', () => {
    const parsed = parse('ALL PRO CONTRACTING(CCC-ARNOLD');
    expect(parsed.businessPart).toBe('ALL PRO CONTRACTING');
    expect(parsed.surname).toBe('ARNOLD');
    expect(parsed.licencePrefix).toBe('CCC');
    // Cut at 30 with `ARNOLD` last, so the surname may be a fragment.
    expect(parsed.surnameTruncated).toBe(true);
  });

  it('reads a bare surname', () => {
    const parsed = parse('COLLIS (LANIER)');
    expect(parsed.surname).toBe('LANIER');
    expect(parsed.licencePrefix).toBeNull();
    expect(parsed.surnameTruncated).toBe(false);
  });

  it('reads a prefix with no surname', () => {
    const parsed = parse('CAPSTONE CONSTRUCTION (CCC)');
    expect(parsed.licencePrefix).toBe('CCC');
    expect(parsed.surname).toBeNull();
  });

  it('reads a licence serial stated outright', () => {
    /**
     * The strongest evidence available in the whole join, and rare — 2 of 1,165 names. Both
     * forms occur.
     */
    expect(parse('LUNDBERG, DAVID C (1325941)').licenceSerial).toBe('1325941');
    const prefixed = parse('NOLANDS ROOFING (CCC-1335461)');
    expect(prefixed.licenceSerial).toBe('1335461');
    expect(prefixed.licencePrefix).toBe('CCC');
  });

  it('refuses a two-character residue as a surname', () => {
    /**
     * `(CC)`, `(JA)`, `(QR)` and `(JO)` all occur in the census — prefixes or given-name
     * initials cut by the column. Matching a surname on two letters returns dozens of
     * licensees and identifies none of them.
     */
    for (const name of ['SOME ROOFING CO (CC)', 'X ROOFING (JA)', 'Y ROOFING (QR)']) {
      expect(parse(name).surname).toBeNull();
    }
  });

  it('takes the last parenthetical, not an earlier one belonging to the name', () => {
    const parsed = parse('ROOF TOP (CFL) SERVICES (CCC-DIA');
    expect(parsed.surname).toBe('DIA');
    expect(parsed.licencePrefix).toBe('CCC');
  });

  it('reports no qualifier when there is none', () => {
    const parsed = parse('BRITE TOP ROOFING');
    expect(parsed.hasQualifier).toBe(false);
    expect(parsed.surname).toBeNull();
    expect(parsed.licenceSerial).toBeNull();
  });

  it('does not call a short unbalanced paren truncated', () => {
    // A typo in a short name has not lost characters to the column.
    expect(parse('ACME (SMITH').surnameTruncated).toBe(false);
  });
});

describe('nameSurvivedTruncation', () => {
  it('treats a cut inside an unclosed qualifier as leaving the name complete', () => {
    /**
     * The BBB tier paid for this distinction. Treating every 30-character name as cut made
     * `NATIONS ROOF RESIDENTIAL LLC(B` search for `NATIONS ROOFING`, dropping `RESIDENTIAL` —
     * the one token that identified the business — from a name that was never truncated.
     */
    expect(nameSurvivedTruncation('NATIONS ROOF RESIDENTIAL LLC(B')).toBe(true);
    expect(nameSurvivedTruncation('COLLIS ROOFING INC (LANIER-CCC')).toBe(true);
    expect(nameSurvivedTruncation('JTO CONTRACTING INC (HOOD CCC)')).toBe(true);
  });

  it('treats a cut in the name itself as truncated', () => {
    expect(nameSurvivedTruncation('SOLAR ROOFING AND CONST(CCC)RU')).toBe(false);
    expect(nameSurvivedTruncation('CENTRAL FLORIDA ROOFING PROFES')).toBe(false);
  });

  it('leaves a short name alone', () => {
    expect(nameSurvivedTruncation('BRITE TOP ROOFING')).toBe(true);
  });
});

describe('looksLikeIndividual', () => {
  it('recognises DBPR\'s own LAST, FIRST convention on the permit side', () => {
    /**
     * A keyed join the BBB tier could not have had: BBB lists businesses, DBPR licenses
     * individuals, and the permit portal writes owner-operators exactly the way DBPR does.
     */
    expect(looksLikeIndividual('MCFADDEN, RICHARD DAVID')).toBe(true);
    expect(looksLikeIndividual('SENEZ, ISAAC EDMOND')).toBe(true);
    expect(looksLikeIndividual('LUNDBERG, DAVID C (CCC)')).toBe(true);
  });

  it('does not mistake a business comma for a person', () => {
    // `PARKER ROOFS, LLC` belongs in the business-name path, where DBPR's `QB` rows hold it.
    expect(looksLikeIndividual('PARKER ROOFS, LLC')).toBe(false);
    expect(looksLikeIndividual('OVIEDO-CLERMONT ROOFING, INC')).toBe(false);
    expect(looksLikeIndividual('BRITE TOP ROOFING')).toBe(false);
  });
});

describe('parsePersonName', () => {
  it('splits a licensee name into surname and given name', () => {
    expect(parsePersonName('MCFADDEN, RICHARD DAVID')).toEqual({
      surname: 'MCFADDEN',
      given: 'RICHARD',
    });
  });

  it('ignores a trailing qualifier', () => {
    expect(parsePersonName('LUNDBERG, DAVID C (CCC)')).toEqual({
      surname: 'LUNDBERG',
      given: 'DAVID',
    });
  });

  it('returns null without both parts', () => {
    expect(parsePersonName('BRITE TOP ROOFING')).toBeNull();
    expect(parsePersonName('SMITH,')).toBeNull();
  });
});
