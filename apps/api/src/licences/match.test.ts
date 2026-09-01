/**
 * The match cascade.
 *
 * The licence records below are verbatim rows from the live extract, and the permit contractor
 * names are verbatim from the real staged census. The negative cases matter more than the
 * positive ones: each one is a confident wrong answer an earlier version of this matcher
 * actually produced.
 */
import { describe, expect, it } from 'vitest';
import { parseCsvRows } from './csv';
import { buildLicenceIndex, matchContractor, referencedSerials } from './match';
import type { LicenceRecord } from './model';
import { parseLicenceRow } from './parse';
import { QUALIFIER_SEED_PREFIXES } from './match';

const CONTEXT = {
  sourceUrl: 'https://example.invalid/CONSTRUCTIONLICENSE_1.csv',
  fetchedAt: '2026-09-01T16:00:00.000Z',
  asOf: new Date('2026-09-01T16:00:00.000Z'),
};

/** Verbatim rows from the live extract, county code `69` unless noted. */
const RAW = {
  lanier:
    '"06","CCC","LANIER, JACK DOUGLAS","COLLIS ROOFING, INC.","","P O BOX 520668","","","LONGWOOD","FL","32752-0668","69","0058022","C","A","08/01/2000","04/27/2001","08/31/2028","","","CCC058022",""',
  hood: '"06","CCC","HOOD, MANLEY JEFFERSON","JTO CONTRACTING, INC.","","x","","","SANFORD","FL","32771","69","1330825","C","A","01/01/2011","01/01/2011","08/31/2028","","","CCC1330825",""',
  dehlinger:
    '"06","CCC","DEHLINGER, APRIL JEANNE","DEHLINGER LLC","","x","","","OVIEDO","FL","32765","69","1332558","C","A","01/01/2015","01/01/2015","08/31/2028","","","CCC1332558",""',
  /** One of 22 Seminole licensees surnamed Miller, and not a roofer. */
  miller:
    '"06","CGC","MILLER, STEVEN R","INDIVIDUAL","","x","","","LONGWOOD","FL","32750","69","0047505","C","A","01/01/1990","01/01/2000","08/31/2028","","","CGC047505",""',
  millerTwo:
    '"06","CBC","MILLER, JAMES T","MILLER HOMES INC","","x","","","SANFORD","FL","32771","69","0012399","C","A","01/01/1990","01/01/2000","08/31/2028","","","CBC012399",""',
  /** Holds two licences, one of them a `CCC`. */
  lundbergCbc:
    '"06","CBC","LUNDBERG, DAVID C","INDIVIDUAL","","519 QUEENSBRIDGE DRIVE","","","LAKE MARY","FL","32746","69","0017995","C","A","01/01/1985","01/01/2000","08/31/2028","","","CBC017995",""',
  lundbergCcc:
    '"06","CCC","LUNDBERG, DAVID C","INDIVIDUAL","","519 QUEENSBRIDGE DRIVE","","","LAKE MARY","FL","32746","69","1325941","C","A","02/12/2004","02/12/2004","08/31/2028","","","CCC1325941",""',
  mcfadden:
    '"06","CCC","MC FADDEN, RICHARD DAVID","MCFADDEN\'S ROOFING INC","","P O BOX 520997","","","LONGWOOD","FL","32752","69","1326427","C","A","04/06/2005","04/06/2005","08/31/2028","","","CCC1326427",""',
  /** A `QB` row: business name in the licensee column. */
  parkerRoofs:
    '"06","QB","PARKER ROOFS, LLC","","","x","","","SANFORD","FL","32771","69","","C","A","01/01/2018","01/01/2018","","","","",""',
  briteTop:
    '"06","QB","BRITE TOP ROOFING INC","","","x","","","LONGWOOD","FL","32750","69","","C","A","01/01/1990","01/01/1995","","","","",""',
  /** Three licences, all on probation. */
  chontasA:
    '"06","CGC","CHONTAS, DEREK STEPHEN","S.R. CHONTAS CONSTRUCTION, INC.","","x","","","OVIEDO","FL","32765","69","1508317","P","A","01/01/2010","01/01/2020","08/31/2028","","","CGC1508317",""',
  chontasB:
    '"06","CCC","CHONTAS, DEREK STEPHEN","S.R. CHONTAS CONSTRUCTION, INC.","","x","","","OVIEDO","FL","32765","69","1329444","P","A","01/01/2010","01/01/2020","08/31/2028","","","CCC1329444",""',
  /** A roofer whose only shared tokens with other roofers are industry words. */
  hcRoofing:
    '"06","CCC","CRUZ, HECTOR","HC ROOFING AND CONSTRUCTION LLC","","x","","","SANFORD","FL","32771","69","1331000","C","A","01/01/2015","01/01/2015","08/31/2028","","","CCC1331000",""',
  /** Registered in Lake County (code `45`), yet pulls Seminole permits. */
  nolandLake:
    '"06","CCC","NOLAND, GREGORY SCOTT","NOLAND\'S ROOFING","","4505 CYPRESS RIDGE LN","","","GROVELAND","FL","34736","45","1335461","C","A","03/11/2024","03/11/2024","08/31/2028","","","CCC1335461",""',
};

function record(line: string): LicenceRecord {
  const [row] = [...parseCsvRows(line)];
  return parseLicenceRow(row as string[], CONTEXT);
}

const SEMINOLE = [
  RAW.lanier,
  RAW.hood,
  RAW.dehlinger,
  RAW.miller,
  RAW.millerTwo,
  RAW.lundbergCbc,
  RAW.lundbergCcc,
  RAW.mcfadden,
  RAW.parkerRoofs,
  RAW.briteTop,
  RAW.chontasA,
  RAW.chontasB,
  RAW.hcRoofing,
].map(record);

const index = buildLicenceIndex(SEMINOLE);

function match(name: string) {
  return matchContractor({ name }, index);
}

describe('tier 1 — a licence serial stated in the permit name', () => {
  it('beats the person match when the two disagree about which licence', () => {
    /**
     * `LUNDBERG, DAVID C` holds both `CBC017995` and `CCC1325941`. The permit names the serial
     * `1325941`, so it says *which* licence — evidence the name alone cannot give, and the
     * reason this tier outranks `individual_name`.
     */
    const result = match('LUNDBERG, DAVID C (1325941)');
    expect(result.matchTier).toBe('licence_number');
    expect(result.licenceNumber).toBe('CCC1325941');
    expect(result.confidence).toBe(1);
    expect(result.keyedMatch).toBe(true);
  });

  it('reaches outside the county for an explicitly named serial', () => {
    /**
     * `NOLANDS ROOFING (CCC-1335461)` pulls Seminole permits but is registered in Lake County.
     * A plain county filter drops the contractor entirely; a stated licence serial is not made
     * wrong by the licensee's address, so it is the one key worth reaching out for.
     */
    const withOutOfCounty = buildLicenceIndex(SEMINOLE, [record(RAW.nolandLake)]);
    const result = matchContractor({ name: 'NOLANDS ROOFING (CCC-1335461)' }, withOutOfCounty);
    expect(result.matchTier).toBe('licence_number');
    expect(result.licenceNumber).toBe('CCC1335461');
    expect(result.countyCode).toBe('45');
  });

  it('collects the serials a contractor list references, for the parse pass', () => {
    const serials = referencedSerials(
      [{ name: 'NOLANDS ROOFING (CCC-1335461)' }, { name: 'BRITE TOP ROOFING' }],
      QUALIFIER_SEED_PREFIXES,
    );
    expect([...serials]).toEqual(['1335461']);
  });
});

describe('tier 2 — surname and prefix resolving uniquely', () => {
  it('matches on the qualifying agent when exactly one licensee answers', () => {
    const hood = match('JTO CONTRACTING INC (HOOD CCC)');
    expect(hood.matchTier).toBe('qualifier_unique');
    expect(hood.licenceNumber).toBe('CCC1330825');
    expect(hood.permitQualifier).toEqual({
      surname: 'HOOD',
      licencePrefix: 'CCC',
      licenceSerial: null,
    });

    const dehlinger = match('DEHLINGER LLC (CCC DEHLINGER)');
    expect(dehlinger.matchTier).toBe('qualifier_unique');
    expect(dehlinger.licenceNumber).toBe('CCC1332558');
  });
});

describe('tier 3 — an ambiguous surname, corroborated by the business name', () => {
  it('matches when a candidate business name shares a distinctive token', () => {
    /**
     * `LANIER` alone is not decisive here, but `COLLIS` is: the permit business name and the
     * licence business name agree on a token that names the business rather than the trade.
     */
    const result = match('COLLIS ROOFING INC (LANIER-CCC');
    expect(result.matched).toBe(true);
    expect(result.licenceNumber).toBe('CCC058022');
    expect(result.licenceBusinessName).toBe('COLLIS ROOFING, INC.');
    expect(result.keyedMatch).toBe(true);
  });

  it('refuses an ambiguous surname with no corroboration', () => {
    /**
     * The false positive this guard exists for. 22 Seminole licensees are surnamed Miller;
     * `MIGHTY DOG ROOFING 232(MILLER)` shares no distinctive token with any of them, and an
     * earlier version confidently claimed `MILLER, STEVEN R` — a general contractor with no
     * connection to Mighty Dog Roofing.
     */
    const result = match('MIGHTY DOG ROOFING 232(MILLER)');
    expect(result.matchTier).not.toBe('qualifier_unique');
    expect(result.matchTier).not.toBe('qualifier_corroborated');
    expect(result.licenseeName).not.toBe('MILLER, STEVEN R');
  });

  it('refuses a surname whose only agreement is industry vocabulary', () => {
    /**
     * `MOMENTUM SOLAR (CCC SMITH)` was claimed as the owner of `DOLPHIN DOCKS, LLC` in an
     * earlier version, on a surname match with no name agreement whatsoever.
     */
    const result = match('MOMENTUM SOLAR (CCC SMITH)');
    expect(result.matched).toBe(false);
  });
});

describe('tier 4 — an individual named the way DBPR names them', () => {
  it('matches LAST, FIRST across the two sources spelling a surname differently', () => {
    // DBPR writes `MC FADDEN`; the permit writes `MCFADDEN`.
    const result = match('MCFADDEN, RICHARD DAVID');
    expect(result.matchTier).toBe('individual_name');
    expect(result.licenceNumber).toBe('CCC1326427');
    expect(result.keyedMatch).toBe(true);
  });

  it('matches a QB row through its business name in the licensee column', () => {
    const result = match('PARKER ROOFS, LLC');
    expect(result.matched).toBe(true);
    expect(result.licenceBusinessName).toBe('PARKER ROOFS, LLC');
    // A `QB` row carries no licence number, and saying so is the honest answer.
    expect(result.licenceNumber).toBeNull();
  });

  it('collapses one licensee\'s several licences instead of picking one blindly', () => {
    const result = match('LUNDBERG, DAVID');
    expect(result.matched).toBe(true);
    expect(result.allLicenceNumbers.sort()).toEqual(['CBC017995', 'CCC1325941']);
  });
});

describe('tier 5 — business-name similarity', () => {
  it('matches an exact normalized business name', () => {
    const result = match('BRITE TOP ROOFING');
    expect(result.matched).toBe(true);
    expect(result.matchTier).toBe('business_exact');
    expect(result.keyedMatch).toBe(false);
  });

  it('refuses a match built only on industry words', () => {
    /**
     * The rule the BBB tier's match rate fell from 85.1% to 78.7% to obtain. `BLITZ` and `HC`
     * are different businesses that happen to share `ROOFING` and `CONSTRUCTION`; agreement on
     * those is evidence that both are roofers, not that they are the same roofer.
     */
    const result = match('BLITZ ROOFING & CONSTRUCTION');
    expect(result.matched).toBe(false);
    expect(result.licenceBusinessName).not.toBe('HC ROOFING AND CONSTRUCTION LLC');
    /**
     * And the score is exactly 0, not a plausible-looking 0.47. `BLITZ` is the only token that
     * identifies this business and no licensee has it, so there is no near miss — reporting a
     * similarity computed against a different roofer would dress noise as evidence.
     */
    expect(result.confidence).toBe(0);
  });

  it('still reports a near miss when something identifying was shared', () => {
    // `MCFADDENS` is distinctive, so this candidate is genuinely close and worth reviewing.
    const result = match('MCFADDENS SIDING');
    expect(result.confidence).toBeGreaterThan(0);
  });
});

describe('reporting the worst licence a licensee holds', () => {
  it('surfaces probation across every licence, not just the headline one', () => {
    /**
     * `CHONTAS, DEREK STEPHEN` holds three Seminole licences, all on probation. Reporting one
     * licence would let a clean licence held by the same person mask an adverse one.
     */
    const result = match('S R CHONTAS CONSTRUCTION INC');
    expect(result.matched).toBe(true);
    expect(result.worstStanding).toBe('probation');
    expect(result.adverse).toBe(true);
    expect(result.allLicenceNumbers).toHaveLength(2);
  });
});

/**
 * Each of these is a wrong answer this matcher produced against the full extract, found by
 * hand-checking a random sample of its own output rather than by reasoning about the code.
 */
describe('grouping name matches by business rather than by licensee', () => {
  /** Verbatim: three unrelated licensees, one trading name. */
  const ICONTRACTING = [
    '"06","CGC","RIVERA, HECTOR A","ICONTRACTING LLC","","495 WINDSWEPT AVENUE SW","","","PALM BAY","FL","32908","15","1528008","C","A","07/23/2019","07/23/2019","08/31/2028","","","CGC1528008",""',
    '"06","CCC","MOREIRA, RODRIGO LEONARDO","ICONTRACTING LLC","","857 LEOPARD  TRAIL","","","WINTER SPRINGS","FL","32708","69","1333243","C","A","08/02/2021","08/02/2021","08/31/2028","","","CCC1333243",""',
  ].map(record);

  /** Verbatim: one licensee, two businesses, and the permit names only one of them. */
  const SOLITRO = [
    '"06","CCC","SOLITRO, JUSTIN SCOTT","PRO LEVEL ROOFING INC.","","480 NEEDLES TRAIL","","","LONGWOOD","FL","32779","69","1332232","C","A","09/26/2019","09/26/2019","08/31/2028","","","CCC1332232",""',
    '"06","CGC","SOLITRO, JUSTIN SCOTT","WEIRSTONE, LLC","","480 NEEDLES TRAIL","","","LONGWOOD","FL","32779","69","1525679","C","A","12/02/2020","12/02/2020","08/31/2028","","","CGC1525679",""',
  ].map(record);

  it('reports the licence carrying the matched name, not the licensee\'s best other one', () => {
    /**
     * Grouped by licensee, `PRO LEVEL ROOFING INC` matched Solitro and then reported his
     * `WEIRSTONE, LLC` licence, because that row sorted best across everything the *person*
     * held. The permit did not ask about Weirstone, and a reader searching DBPR for the
     * reported number would not find the company on the permit.
     */
    const result = matchContractor({ name: 'PRO LEVEL ROOFING INC' }, buildLicenceIndex(SOLITRO));
    expect(result.matchTier).toBe('business_exact');
    expect(result.licenceBusinessName).toBe('PRO LEVEL ROOFING INC.');
    expect(result.licenceNumber).toBe('CCC1332232');
  });

  it('keeps a shared trading name as one entity across its several licensees', () => {
    /**
     * Three different people qualify `ICONTRACTING LLC`. Under a licensee grouping the permit
     * landed on whichever the scan reached first; grouped by name, the candidate set is the
     * rows that actually carry it and the nearest county breaks the tie.
     */
    const result = matchContractor(
      { name: 'ICONTRACTING LLC (CCC)' },
      buildLicenceIndex(ICONTRACTING),
    );
    expect(result.matchTier).toBe('business_exact');
    expect(result.licenceBusinessName).toBe('ICONTRACTING LLC');
    expect(result.allLicenceNumbers).toHaveLength(2);
    // Winter Springs is in Seminole; Palm Bay is in Brevard.
    expect(result.countyCode).toBe('69');
  });
});

describe('choosing which of an entity\'s licences to report', () => {
  /** Verbatim: a `QB` registration alongside the certified licence that has lapsed. */
  const EXPIRED_WITH_QB = [
    '"06","CCC","CREEL, WILLIAM EUGENE","GLORY BOUND ROOFING INC","","x","","","ORLANDO","FL","32801","58","1325846","C","A","01/01/2005","01/01/2005","08/31/2026","","","CCC1325846",""',
    '"06","QB","GLORY BOUND ROOFING INC","","","x","","","ORLANDO","FL","32801","58","","C","","01/01/2005","01/01/2005","","","","",""',
  ].map(record);

  it('prefers a real licence over a QB registration, so a lapse cannot hide behind it', () => {
    /**
     * A `QB` row has no number, no expiry and no secondary status, so it always derives to
     * `current_unspecified` — which outranks `expired` under a plain standing sort. Ordering
     * on standing alone therefore reported `current_unspecified` for a business whose
     * certified licence had lapsed, suppressing the whole point of this tier.
     */
    const result = matchContractor(
      { name: 'GLORY BOUND ROOFING INC' },
      buildLicenceIndex(EXPIRED_WITH_QB),
    );
    expect(result.licenceNumber).toBe('CCC1325846');
    expect(result.standing).toBe('expired');
    expect(result.adverse).toBe(true);
  });

  it('answers with the qualifier the permit named', () => {
    /**
     * `DEHLINGER CONSTRUCTION (CCC RE` is a 30-character cut of `(CCC RECTOR)`. The business
     * has several qualifiers; the permit says which one, and his licence is the expired one.
     */
    const dehlingerLlc = [
      '"06","CCC","RECTOR, SAMUEL CLAYTON","DEHLINGER CONSTRUCTION, LLC","","x","","","FRUITLAND PARK","FL","34731","45","1331442","C","A","01/01/2015","01/01/2015","08/31/2026","","","CCC1331442",""',
      '"06","CRC","DEHLINGER, APRIL JEANNE","DEHLINGER CONSTRUCTION, LLC","","x","","","LONGWOOD","FL","32750","69","1331934","C","A","01/01/2015","01/01/2015","08/31/2028","","","CRC1331934",""',
    ].map(record);
    const result = matchContractor(
      { name: 'DEHLINGER CONSTRUCTION (CCC RE' },
      buildLicenceIndex(dehlingerLlc),
    );
    expect(result.licenceNumber).toBe('CCC1331442');
    expect(result.standing).toBe('expired');
  });

  it('does not call a roofer adverse for a lapsed licence in another trade', () => {
    /**
     * Verbatim `COLLIS ROOFING, INC.`: a current roofing `CCC`, a current general `CGC`, and a
     * `CFC` plumbing licence that lapsed. Rolling up every trade reported `expired` against
     * the largest roofer in the census — 760 permits — while its roofing licence ran to 2028.
     */
    const collis = [
      '"06","CCC","LANIER, JACK DOUGLAS","COLLIS ROOFING, INC.","","x","","","LONGWOOD","FL","32752","69","0058022","C","A","08/01/2000","04/27/2001","08/31/2028","","","CCC058022",""',
      '"06","CGC","SHAFFER, WILLIAM NOAH","COLLIS ROOFING, INC.","","x","","","LONGWOOD","FL","32752","69","1522375","C","A","01/01/2013","01/01/2013","08/31/2028","","","CGC1522375",""',
      '"06","CFC","VAN NUYS, SCOTT ERIC","COLLIS ROOFING, INC.","","x","","","LONGWOOD","FL","32752","69","1429287","C","A","01/01/2004","01/01/2004","08/31/2026","","","CFC1429287",""',
    ].map(record);
    const result = matchContractor({ name: 'COLLIS ROOFING INC' }, buildLicenceIndex(collis));
    expect(result.matched).toBe(true);
    expect(result.licenceNumber).toBe('CCC058022');
    expect(result.worstStanding).toBe('active');
    expect(result.adverse).toBe(false);
    // The plumbing licence is still disclosed, just not treated as a roofing signal.
    expect(result.allLicenceNumbers).toContain('CFC1429287');
  });

  it('prefers a roofing-capable class over an unrelated trade', () => {
    /**
     * `RLH CONSTRUCTION, LLC` holds a plumbing `CPC` and a general `CGC`, both current and
     * both in Seminole. With nothing else to separate them the plumbing licence was reported
     * against a roofing permit.
     */
    const rlh = [
      '"06","CPC","BOLLI, ORLANDO ROBERT","RLH CONSTRUCTION, LLC","A","x","","","OVIEDO","FL","32765","69","1457133","C","A","11/30/2005","09/22/2014","08/31/2028","","","CPC1457133",""',
      '"06","CGC","BOLLI, ORLANDO ROBERT","RLH CONSTRUCTION, LLC","","x","","","OVIEDO","FL","32765","69","1520671","C","A","06/11/2012","06/15/2024","08/31/2028","","","CGC1520671",""',
    ].map(record);
    const result = matchContractor({ name: 'RLH CONSTRUCTION (HILLERY CBC)' }, buildLicenceIndex(rlh));
    expect(result.licenceType).toBe('CGC');
  });
});

describe('claims the matcher must refuse to make', () => {
  it('declines a match resting only on trade vocabulary', () => {
    /**
     * `EXTERIOR` was distinctive only because the generic list held the plural. One shared
     * trade word, over thirteen other candidates, scored 0.875.
     */
    const homesavers = [
      '"06","QB","EXTERIOR HOMESAVERS INC","","","x","","","SANFORD","FL","32771","69","","C","A","01/01/2000","01/01/2005","","","","",""',
    ].map(record);
    const result = matchContractor(
      { name: 'THE EXTERIOR COMPANY INC' },
      buildLicenceIndex(homesavers),
    );
    expect(result.matched).toBe(false);
  });

  it('does not read a legal form as part of the name', () => {
    /**
     * `... , A JOINT VENTURE` describes how the entity is organised. Left on, it made
     * `VENTURE` look like an identifying token and claimed a Balfour Beatty joint venture for
     * an unrelated contractor.
     */
    const jointVenture = [
      '"06","QB","BALFOUR BEATTY CONSTRUCTION/ALEXANDER GROUP, A JOINT VENTURE","","","x","","","ORLANDO","FL","32801","58","","C","A","01/01/2010","01/01/2010","","","","",""',
    ].map(record);
    const result = matchContractor(
      { name: 'VENTURE CONSTRUCTION GROUP (CC' },
      buildLicenceIndex(jointVenture),
    );
    expect(result.matched).toBe(false);
  });

  it('does not fall back to fuzzy business matching for a person name', () => {
    /**
     * `ORIE, THOMAS A` was claimed as `PARRISH, THOMAS A` at 0.65, on the given name alone.
     * When the person tier declines, similarity has nothing identifying left to work with.
     */
    const parrish = [
      '"06","CFC","PARRISH, THOMAS A","TOM PARRISH PLUMBING LLC","","x","","","ST. CLOUD","FL","34769","59","1431184","C","A","01/01/2010","01/01/2010","08/31/2028","","","CFC1431184",""',
    ].map(record);
    const result = matchContractor({ name: 'ORIE, THOMAS A' }, buildLicenceIndex(parrish));
    expect(result.matched).toBe(false);
  });

  it('drops a unique surname when the business name contradicts it', () => {
    /**
     * `(ROBERT)` is a given name, but exactly one licensee was surnamed Robert, so the
     * uniqueness rule confidently returned their unrelated company.
     */
    const woodCraft = [
      '"06","CGC","ROBERT, MARC ANTOINE","WOOD CRAFT","","x","","","ORLANDO","FL","32801","58","1539771","C","A","01/01/2020","01/01/2020","08/31/2028","","","CGC1539771",""',
      '"06","QB","AAGAARD-JUERGENSEN INC","","","x","","","ORLANDO","FL","32801","58","","C","A","01/01/1980","01/01/1990","","","","",""',
    ].map(record);
    const result = matchContractor(
      { name: 'AAGAARD-JUERGENSEN (ROBERT) LL' },
      buildLicenceIndex(woodCraft),
    );
    expect(result.licenceBusinessName).not.toBe('WOOD CRAFT');
    expect(result.licenceNumber).not.toBe('CGC1539771');
  });
});

describe('an unmatched contractor', () => {
  it('carries its best score and no licence claim', () => {
    const result = match('ZZZ ENTIRELY UNKNOWN VENDOR');
    expect(result.matched).toBe(false);
    expect(result.matchTier).toBeNull();
    expect(result.standing).toBeNull();
    expect(result.licenceNumber).toBeNull();
    expect(result.allLicenceNumbers).toEqual([]);
  });
});
