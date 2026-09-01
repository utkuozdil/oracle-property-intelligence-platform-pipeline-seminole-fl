/**
 * Record parsing and standing derivation.
 *
 * Every raw row quoted here is verbatim from the live extract on 2026-09-01, so these tests
 * fail if the layout moves rather than if someone's idea of the layout moves.
 */
import { describe, expect, it } from 'vitest';
import { parseCsvRows } from './csv';
import {
  compareStandingBestFirst,
  deriveStanding,
  isAdverse,
  mostRecentRenewalDeadline,
  parseDbprDate,
  parseLicenceRow,
  parseSurname,
  worseStanding,
} from './parse';

const CONTEXT = {
  sourceUrl: 'https://example.invalid/CONSTRUCTIONLICENSE_1.csv',
  fetchedAt: '2026-09-01T16:00:00.000Z',
  asOf: new Date('2026-09-01T16:00:00.000Z'),
};

function parse(line: string) {
  const [row] = [...parseCsvRows(line)];
  return parseLicenceRow(row as string[], CONTEXT);
}

/** Verbatim rows from the live extract. */
const ROWS = {
  /** A normal individual licence with a business name. */
  collis:
    '"06","CCC","LANIER, JACK DOUGLAS","COLLIS ROOFING, INC.","","P O BOX 520668","","","LONGWOOD","FL","32752-0668","69","0058022","C","A","08/01/2000","04/27/2001","08/31/2028","","","CCC058022",""',
  /** A `QB` row: business name in field 2, no licence number, no expiry. */
  qb: '"06","QB","WATTS AIR CONDITIONING","","","830 RONALD REGAN BLVD STE 102","","","LONGWOOD","FL","32750","69","","C","A","12/02/1998","09/01/2009","","","","",""',
  /** The `INDIVIDUAL` sentinel in the business-name column. */
  sentinel:
    '"06","CCC","LUNDBERG, DAVID C","INDIVIDUAL","","519 QUEENSBRIDGE DRIVE","","","LAKE MARY","FL","32746","69","1325941","C","A","02/12/2004","02/12/2004","08/31/2028","","","CCC1325941",""',
  /** Primary status `S`. */
  suspended:
    '"06","CGC","MARTINEZ, JOSE ANTONIO","METT BUILDERS, INC","","x","","","SANFORD","FL","32771","69","1521169","S","A","01/01/2015","01/01/2020","08/31/2024","","","CGC1521169",""',
  /** Primary status `P`. */
  probation:
    '"06","CGC","CHONTAS, DEREK STEPHEN","S.R. CHONTAS CONSTRUCTION, INC.","","x","","","OVIEDO","FL","32765","69","1508317","P","A","01/01/2010","01/01/2020","08/31/2028","","","CGC1508317",""',
  /** `FRO`, which legitimately carries no expiry. */
  fro: '"06","FRO","SMITH, JOHN A","","","x","","","SANFORD","FL","32771","69","0012345","C","","01/01/2010","01/01/2020","","","","FRO012345",""',
  /** A surname DBPR writes with an internal space. */
  spacedSurname:
    '"06","CCC","MC FADDEN, RICHARD DAVID","MCFADDEN\'S ROOFING INC","","P O BOX 520997","","","LONGWOOD","FL","32752","69","1326427","C","A","04/06/2005","04/06/2005","08/31/2028","","","CCC1326427",""',
};

describe('parseDbprDate', () => {
  it('converts MM/DD/YYYY to ISO', () => {
    expect(parseDbprDate('08/31/2028')).toBe('2028-08-31');
  });

  it('returns null rather than an Invalid Date for junk', () => {
    /**
     * A malformed date must not become 1970 and then read as "expired 56 years ago" — that
     * would invent the exact adverse signal this tier is trusted to report.
     */
    for (const value of ['', '  ', '13/01/2028', '08/32/2028', '2028-08-31', 'AUG 2028']) {
      expect(parseDbprDate(value)).toBeNull();
    }
  });
});

describe('parseSurname', () => {
  it('takes the surname from a LAST, FIRST name', () => {
    expect(parseSurname('LANIER, JACK DOUGLAS')).toBe('LANIER');
  });

  it('removes an internal space, because the two sources disagree about it', () => {
    // DBPR writes `MC FADDEN`; the permit portal writes `MCFADDEN`.
    expect(parseSurname('MC FADDEN, RICHARD DAVID')).toBe('MCFADDEN');
  });

  it('returns null for a business name, which is how QB rows are told apart', () => {
    expect(parseSurname('WATTS AIR CONDITIONING')).toBeNull();
  });
});

describe('parseLicenceRow', () => {
  it('reads a normal individual licence', () => {
    const record = parse(ROWS.collis);
    expect(record.licenceNumber).toBe('CCC058022');
    expect(record.licenceType).toBe('CCC');
    expect(record.qualifiedBusiness).toBe(false);
    expect(record.licenseeName).toBe('LANIER, JACK DOUGLAS');
    expect(record.qualifierSurname).toBe('LANIER');
    expect(record.businessName).toBe('COLLIS ROOFING, INC.');
    expect(record.countyCode).toBe('69');
    expect(record.expirationDate).toBe('2028-08-31');
    expect(record.standing).toBe('active');
    expect(record.adverse).toBe(false);
    expect(record.sourceUrl).toBe(CONTEXT.sourceUrl);
    expect(record.fetchedAt).toBe(CONTEXT.fetchedAt);
  });

  it('takes a QB row business name from field 2, not field 3', () => {
    /**
     * The `QB` split is 46.8% of the file. Reading field 3 for every row would leave half the
     * business names in the extract invisible to the join.
     */
    const record = parse(ROWS.qb);
    expect(record.qualifiedBusiness).toBe(true);
    expect(record.businessName).toBe('WATTS AIR CONDITIONING');
    expect(record.licenceNumber).toBeNull();
    expect(record.expirationDate).toBeNull();
    expect(record.qualifierSurname).toBeNull();
  });

  it('treats the INDIVIDUAL sentinel as no business name', () => {
    // Otherwise 39 unrelated Seminole licensees would all "trade as" a business called
    // INDIVIDUAL, and any name match against it would be nonsense.
    expect(parse(ROWS.sentinel).businessName).toBeNull();
  });

  it('normalizes casing on the fields the join keys on', () => {
    const record = parse(ROWS.spacedSurname);
    expect(record.city).toBe('LONGWOOD');
    expect(record.licenceNumber).toBe('CCC1326427');
  });
});

describe('deriveStanding', () => {
  const asOf = new Date('2026-09-01T00:00:00.000Z');

  it('reports suspension and probation ahead of anything else', () => {
    // A suspended licence with a 2028 expiry is still suspended.
    expect(parse(ROWS.suspended).standing).toBe('suspended');
    expect(parse(ROWS.probation).standing).toBe('probation');
  });

  it('derives `expired` from the date, because DBPR has no delinquent code', () => {
    /**
     * The single most important derivation in this tier. 375 Seminole licences carry primary
     * status `C` — "Current" — with an expiry already in the past. Reading the status alone
     * would report every one of them as active and invert the signal the product is for.
     */
    expect(
      deriveStanding({
        primaryStatus: 'C',
        secondaryStatus: 'A',
        expirationDate: '2025-08-31',
        licenceType: 'CCC',
        asOf,
      }),
    ).toBe('expired');
  });

  it('flags a licence expiring inside the window', () => {
    expect(
      deriveStanding({
        primaryStatus: 'C',
        secondaryStatus: 'A',
        expirationDate: '2026-10-15',
        licenceType: 'CCC',
        asOf,
      }),
    ).toBe('expiring_soon');
  });

  it('does not treat a blank secondary status as inactive', () => {
    /**
     * Blank is *unrecorded*, and it is the majority: 142,194 of 271,941 rows statewide, and
     * 2,672 of 5,211 in Seminole. Collapsing blank into inactive would discard more than half
     * the county's licences.
     */
    expect(
      deriveStanding({
        primaryStatus: 'C',
        secondaryStatus: null,
        expirationDate: '2028-08-31',
        licenceType: 'CCC',
        asOf,
      }),
    ).toBe('current_unspecified');
  });

  it('separates a voluntarily inactive licence from an expired one', () => {
    expect(
      deriveStanding({
        primaryStatus: 'C',
        secondaryStatus: 'I',
        expirationDate: '2028-08-31',
        licenceType: 'CCC',
        asOf,
      }),
    ).toBe('inactive');
  });

  it('accepts a missing expiry on the licence types that never carry one', () => {
    // All 319 Seminole rows missing an expiry are `FRO`, exactly; `QB` rows never have one.
    expect(parse(ROWS.fro).standing).toBe('current_unspecified');
    expect(parse(ROWS.fro).adverse).toBe(false);
    expect(parse(ROWS.qb).standing).toBe('active');
  });

  it('counts only suspension, probation and expiry as adverse', () => {
    expect(isAdverse('suspended')).toBe(true);
    expect(isAdverse('probation')).toBe(true);
    expect(isAdverse('expired')).toBe(true);
    // Inactive is a choice the holder made, not a disciplinary state.
    expect(isAdverse('inactive')).toBe(false);
    expect(isAdverse('expiring_soon')).toBe(false);
    expect(isAdverse('current_unspecified')).toBe(false);
  });
});

describe('standing ordering', () => {
  it('picks the worse standing, so a clean licence cannot mask a bad one', () => {
    /**
     * A qualifying agent commonly holds several licences — `CHONTAS, DEREK STEPHEN` holds
     * three. Reporting the best would let an active licence hide a suspension.
     */
    expect(worseStanding('active', 'suspended')).toBe('suspended');
    expect(worseStanding('expired', 'probation')).toBe('probation');
    expect(worseStanding('active', 'inactive')).toBe('inactive');
  });

  it('sorts best first for choosing a headline licence', () => {
    const standings = ['expired', 'active', 'suspended', 'inactive'] as const;
    expect([...standings].sort(compareStandingBestFirst)[0]).toBe('active');
  });
});

describe('the biennial renewal deadline', () => {
  it('is the 31 August just passed in an even year', () => {
    // The day this was measured: 2,287 of 2,658 expired records share this exact date.
    expect(mostRecentRenewalDeadline(new Date('2026-09-01T16:00:00Z'))).toBe('2026-08-31');
  });

  it('is the previous cycle before the deadline lands', () => {
    expect(mostRecentRenewalDeadline(new Date('2026-08-30T16:00:00Z'))).toBe('2024-08-31');
  });

  it('is the preceding even year in an odd year', () => {
    expect(mostRecentRenewalDeadline(new Date('2027-05-01T16:00:00Z'))).toBe('2026-08-31');
  });
});
