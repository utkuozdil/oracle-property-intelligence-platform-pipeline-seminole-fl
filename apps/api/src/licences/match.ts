/**
 * Joining permit contractor names to DBPR licences.
 *
 * A cascade, strongest evidence first, and it stops at the first tier that produces an
 * unambiguous answer:
 *
 *   1. licence serial stated in the permit name        keyed, exact
 *   2. qualifier surname + licence prefix, unique      keyed, exact
 *   3. qualifier surname, corroborated by business name keyed, corroborated
 *   4. individual `LAST, FIRST` -> licensee name        keyed
 *   5. business-name similarity                         fuzzy, BBB's rules
 *
 * The first four rest on something the permit portal *states* — a licence serial, a
 * qualifying agent's surname, a licence-type prefix, a person's name — rather than on
 * similarity. That is the substantive difference between this join and the BBB one, and it
 * is why the keyed match rate is reported separately from the total: they are different
 * grades of claim, and a consumer showing "licence suspended" against a named contractor
 * should be able to filter on the stronger one.
 *
 * Nothing here invents a match. A contractor whose best candidate is ambiguous is emitted
 * unmatched with the score it reached, which is what makes the reported rate a measurement.
 */
import {
  countyRank,
  isTradeRelevant,
  MATCH_CONFIDENCE_FLOOR,
  QUALIFIED_BUSINESS_PREFIX,
  tradeRank,
} from './config';
import type {
  ContractorLicenceMatch,
  LicenceRecord,
  LicenceStanding,
  MatchTier,
} from './model';
import { KEYED_MATCH_TIERS } from './model';
import {
  isDistinctiveToken,
  normalizeBusinessName,
  similarity,
  type NormalizedName,
} from './normalize';
import { compareStandingBestFirst, worseStanding } from './parse';
import {
  looksLikeIndividual,
  nameSurvivedTruncation,
  parseContractorName,
  parsePersonName,
} from './qualifier';

export interface PermitContractor {
  name: string;
  permitCount?: number;
}

/**
 * A set of licence rows that answer as one identity, plus the names it answers to.
 *
 * Matching to a single row would let a clean licence mask an adverse one on the same
 * identity, so the unit of the join is always a group. There are two ways to group, and the
 * cascade uses both — see `Licensee` and `Business`.
 */
interface MatchEntity {
  licenceRecords: LicenceRecord[];
  names: { raw: string; normalized: NormalizedName }[];
}

/**
 * A qualifying agent and every licence they hold.
 *
 * The right grouping for the *keyed* tiers, which identify a person: a serial, a qualifier
 * surname, a `LAST, FIRST` name. `CHONTAS, DEREK STEPHEN` holds three Seminole licences, all
 * on probation, and `LUNDBERG, DAVID C` holds both a `CBC` and a `CCC`.
 */
interface Licensee extends MatchEntity {
  /** DBPR's own spelling of the licensee, used as the identity key. */
  key: string;
  surname: string | null;
}

/**
 * A trading name and every licence row issued under it, across licensees.
 *
 * The right grouping for the *name* tier, because a permit names a business, not a person,
 * and the two do not correspond. Grouping name matches by licensee produced answers that
 * were wrong in both directions when checked against the file:
 *
 *  - `ICONTRACTING LLC` is carried by three unrelated licensees — Rivera in Palm Bay, Neira
 *    in Orlando, Moreira in Winter Springs. Under a licensee grouping the permit name landed
 *    on whichever one the scan reached first, silently.
 *  - `PRO LEVEL ROOFING INC` matched Justin Solitro correctly, and then reported his
 *    `WEIRSTONE, LLC` licence, because that row happened to have the best standing of
 *    everything the *person* held. The permit did not ask about Weirstone.
 *
 * Grouping by name fixes both: the candidate set is the rows that actually carry the matched
 * name, so the reported licence is one a reader can find by searching for it.
 */
interface Business extends MatchEntity {
  key: string;
}

export interface LicenceIndex {
  licensees: Licensee[];
  /** Trading names, the entities the fuzzy name tier resolves to. */
  businesses: Business[];
  /** Licence-type prefixes present in the data, for parsing qualifier parentheticals. */
  licencePrefixes: ReadonlySet<string>;
  bySurname: Map<string, Licensee[]>;
  bySurnameAndPrefix: Map<string, Licensee[]>;
  byPerson: Map<string, Licensee[]>;
  /** Serial (leading zeros stripped) to licensees, including out-of-county exact hits. */
  bySerial: Map<string, Licensee[]>;
  /**
   * Blocking index for the fuzzy tier: candidate keys to the businesses that could plausibly
   * score above the floor under them.
   *
   * Without this the fuzzy tier is a full scan, which is fine against one county's ~4,500
   * entities and quadratic nonsense against the state's ~230,000 — 2,367 contractor names
   * against every entity is over 500 million similarity computations, and it does not
   * finish. Blocking is what makes a scope wider than one county possible at all.
   */
  blocks: Map<string, Business[]>;
}

/**
 * Prefix length used to block truncated permit names.
 *
 * A 30-character permit name is compared as a character prefix, so its candidates cannot be
 * found by shared tokens — the cut token is a fragment that matches nothing exactly. Four
 * characters is short enough that a genuine continuation always shares them and long enough
 * to keep the bucket small.
 */
const PREFIX_BLOCK_LENGTH = 4;

/**
 * Blocking keys for a candidate name.
 *
 * These are chosen to be *equivalence-preserving* rather than merely plausible, which matters
 * because a missed block is a silently missed match. `similarity` can only return a score above
 * its generic-only cap of 0.5 — and therefore above the 0.6 floor — in four ways, and each has
 * a key here:
 *
 *  - exact normalized-key equality      -> the full key
 *  - containment on a distinctive token -> that token
 *  - blended, gated on a shared token   -> that token
 *  - truncated-prefix continuation      -> the leading characters
 */
function blockKeysFor(name: NormalizedName): string[] {
  const keys: string[] = [];
  if (name.key.length > 0) keys.push(`k:${name.key}`);
  for (const token of name.tokens) {
    if (isDistinctiveToken(token)) keys.push(`t:${token}`);
  }
  if (name.compact.length >= PREFIX_BLOCK_LENGTH) {
    keys.push(`p:${name.compact.slice(0, PREFIX_BLOCK_LENGTH)}`);
  }
  return keys;
}

function licenseeKey(record: LicenceRecord): string {
  return record.licenseeName.toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Orders licence rows so the reported one comes first: real licences before `QB` rows, then
 * best standing.
 *
 * A `QB` row is a business *registration*, not a licence. It has no number, no expiry and no
 * secondary status, so it always derives to `current_unspecified` — which is neither good nor
 * bad, and outranks `expired` under a pure standing sort. Ordering on standing alone therefore
 * let a registration row become the headline and report `current_unspecified` for a business
 * whose actual certified licence had lapsed, hiding exactly the signal this tier exists to
 * surface. Real licences win the headline whenever the entity has one.
 */
function compareForHeadline(left: LicenceRecord, right: LicenceRecord): number {
  if (left.qualifiedBusiness !== right.qualifiedBusiness) return left.qualifiedBusiness ? 1 : -1;
  const standing = compareStandingBestFirst(left.standing, right.standing);
  if (standing !== 0) return standing;
  const county = countyRank(left.countyCode) - countyRank(right.countyCode);
  if (county !== 0) return county;
  return tradeRank(left.licenceType) - tradeRank(right.licenceType);
}

/** Nearest county wins an otherwise-equal name match; see `countyRank`. */
function nearestFirst(entity: MatchEntity): number {
  let best = 3;
  for (const record of entity.licenceRecords) best = Math.min(best, countyRank(record.countyCode));
  return best;
}

function stripLeadingZeros(value: string): string {
  return value.replace(/^0+/, '');
}

/** Serial digits from a full licence number such as `CCC058022`. */
function serialOf(record: LicenceRecord): string | null {
  if (record.licenceNumber === null) return null;
  const digits = /(\d+)\s*$/.exec(record.licenceNumber);
  return digits ? stripLeadingZeros(digits[1] as string) : null;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/**
 * Groups licence records into licensees and builds every lookup the cascade needs.
 *
 * `records` is the county population; `outOfCountyBySerial` carries the handful of
 * statewide records retained because a permit name referenced their serial outright. See
 * `parseExtract` for why those are fetched narrowly rather than by keeping the whole state
 * in memory.
 */
export function buildLicenceIndex(
  records: readonly LicenceRecord[],
  outOfCountyBySerial: readonly LicenceRecord[] = [],
): LicenceIndex {
  const byKey = new Map<string, Licensee>();
  const licencePrefixes = new Set<string>();

  const add = (record: LicenceRecord): Licensee => {
    licencePrefixes.add(record.licenceType);
    const key = licenseeKey(record);
    let licensee = byKey.get(key);
    if (!licensee) {
      licensee = { key, licenceRecords: [], names: [], surname: record.qualifierSurname };
      byKey.set(key, licensee);
    }
    licensee.licenceRecords.push(record);
    licensee.surname ??= record.qualifierSurname;
    return licensee;
  };

  for (const record of records) add(record);
  const outOfCounty = outOfCountyBySerial.map(add);

  for (const licensee of byKey.values()) {
    /**
     * A licensee is matchable under their own name and under every business name attached to
     * any of their licences. `QB` rows contribute the business name they carry in field 2,
     * which is the only place half the file's business names appear at all.
     */
    const raws = new Set<string>();
    raws.add(licensee.licenceRecords[0]?.licenseeName ?? licensee.key);
    for (const record of licensee.licenceRecords) {
      if (record.businessName !== null) raws.add(record.businessName);
    }
    licensee.names = [...raws]
      .filter((raw) => raw.trim().length > 0)
      // A DBPR name is never width-truncated, so it is normalized as a complete name.
      .map((raw) => ({ raw, normalized: normalizeBusinessName(raw, { truncatedInput: false }) }));
    licensee.licenceRecords.sort(compareForHeadline);
  }

  /**
   * Trading names, grouped across licensees.
   *
   * `QB` rows carry their business name in the licensee column and `parseLicenceRow` has
   * already moved it into `businessName`, so both row kinds contribute here uniformly. A
   * licensee trading under their own name contributes nothing — the `INDIVIDUAL` sentinel is
   * dropped at parse time — and is reachable through the person tiers instead.
   */
  const byBusiness = new Map<string, Business>();
  for (const record of [...records, ...outOfCountyBySerial]) {
    if (record.businessName === null) continue;
    const normalized = normalizeBusinessName(record.businessName, { truncatedInput: false });
    if (normalized.key.length === 0) continue;
    let business = byBusiness.get(normalized.key);
    if (!business) {
      business = { key: normalized.key, licenceRecords: [], names: [] };
      byBusiness.set(normalized.key, business);
    }
    business.licenceRecords.push(record);
    if (!business.names.some((name) => name.raw === record.businessName)) {
      business.names.push({ raw: record.businessName, normalized });
    }
  }
  for (const business of byBusiness.values()) {
    business.licenceRecords.sort(compareForHeadline);
  }

  const index: LicenceIndex = {
    licensees: [...byKey.values()],
    businesses: [...byBusiness.values()],
    licencePrefixes,
    bySurname: new Map(),
    bySurnameAndPrefix: new Map(),
    byPerson: new Map(),
    bySerial: new Map(),
    blocks: new Map(),
  };

  const outOfCountySet = new Set(outOfCounty);

  for (const licensee of index.licensees) {
    const inCounty = !outOfCountySet.has(licensee);
    if (licensee.surname !== null && inCounty) {
      push(index.bySurname, licensee.surname, licensee);
      for (const record of licensee.licenceRecords) {
        push(index.bySurnameAndPrefix, `${licensee.surname}|${record.licenceType}`, licensee);
      }
      const person = parsePersonName(licensee.licenceRecords[0]?.licenseeName ?? '');
      if (person) push(index.byPerson, `${person.surname}|${person.given}`, licensee);
    }
    /**
     * `QB` rows carry a business name in the licensee column, so they are also reachable by
     * that name in the person index — which is how `PARKER ROOFS, LLC` finds its `QB` row.
     */
    if (licensee.surname === null && inCounty) {
      const asBusiness = normalizeBusinessName(licensee.licenceRecords[0]?.licenseeName ?? '');
      if (asBusiness.key.length > 0) push(index.byPerson, `BUSINESS|${asBusiness.key}`, licensee);
    }
    for (const record of licensee.licenceRecords) {
      const serial = serialOf(record);
      if (serial !== null) push(index.bySerial, serial, licensee);
    }
  }

  for (const business of index.businesses) {
    const blockKeys = new Set<string>();
    for (const name of business.names) {
      for (const key of blockKeysFor(name.normalized)) blockKeys.add(key);
    }
    for (const key of blockKeys) push(index.blocks, key, business);
  }

  // De-duplicate: one licensee can contribute several licences under the same surname key.
  for (const map of [index.bySurname, index.bySurnameAndPrefix, index.byPerson, index.bySerial]) {
    for (const [key, list] of map) map.set(key, [...new Set(list)]);
  }

  return index;
}

/**
 * The licensees worth scoring against a permit name.
 *
 * Returns null when the name is too generic to block on — an all-generic, non-truncated name
 * like `ROOFING COMPANY` — in which case the caller scans everything. That case cannot produce
 * a match above the floor anyway, but scanning keeps this function's contract simple: never
 * silently narrow the search.
 */
function blockedCandidates(index: LicenceIndex, permit: NormalizedName): Business[] | null {
  const keys = blockKeysFor(permit);
  if (keys.length === 0) return null;
  const seen = new Set<Business>();
  for (const key of keys) {
    for (const business of index.blocks.get(key) ?? []) seen.add(business);
  }
  return [...seen];
}

/**
 * The licence to report and the worst standing behind it.
 *
 * Two exclusions, both learned from the output rather than reasoned about in advance.
 *
 * `QB` rows are excluded for the same reason they lose the headline: `current_unspecified` on
 * a registration row is an absence of information, and folding it in would drag a genuinely
 * `active` entity down and manufacture an adverse-looking signal.
 *
 * Licences in unrelated trades are excluded because the question this tier answers is whether
 * the contractor could lawfully do *this* work. Rolling up every trade made `COLLIS ROOFING,
 * INC.` — 760 Seminole permits, the largest roofer in the census — read `expired`, on the
 * strength of a lapsed `CFC` *plumbing* licence held by a third qualifier. Its roofing `CCC`
 * and general `CGC` are both current to 2028. That is a false lead against the single most
 * prominent contractor in the dataset, which is the worst place to be wrong.
 *
 * Where a business holds nothing trade-relevant the roll-up falls back to its real licences,
 * so the signal degrades to "something here is adverse" rather than disappearing.
 */
function standings(entity: MatchEntity): { headline: LicenceRecord; worst: LicenceStanding } {
  const headline = entity.licenceRecords[0] as LicenceRecord;
  const real = entity.licenceRecords.filter((record) => !record.qualifiedBusiness);
  const relevant = real.filter((record) => isTradeRelevant(record.licenceType));
  const rollUp = relevant.length > 0 ? relevant : real.length > 0 ? real : entity.licenceRecords;
  let worst = (rollUp[0] as LicenceRecord).standing;
  for (const record of rollUp) worst = worseStanding(worst, record.standing);
  return { headline, worst };
}

/**
 * Whether a candidate licensee's names corroborate a permit business name.
 *
 * Requires a shared *distinctive* token, not merely a plausible score, because this is the
 * guard that keeps the ambiguous-surname tier honest. Measured against the real census, a
 * bare surname match with no corroboration claimed `MIGHTY DOG ROOFING 232(MILLER)` as
 * `MILLER, STEVEN R` — one of 22 Seminole licensees surnamed Miller — and `MOMENTUM SOLAR
 * (CCC SMITH)` as the owner of `DOLPHIN DOCKS, LLC`. Both are confident nonsense.
 */
function corroboration(
  permitBusiness: NormalizedName,
  licensee: Licensee,
): { score: number; matchedName: string } | null {
  const distinctive = permitBusiness.tokens.filter(isDistinctiveToken);
  if (distinctive.length === 0) return null;

  let best: { score: number; matchedName: string } | null = null;
  for (const name of licensee.names) {
    const shared = distinctive.some((token) => name.normalized.tokens.includes(token));
    if (!shared) continue;
    const { score } = similarity(permitBusiness, name.normalized);
    if (!best || score > best.score) best = { score, matchedName: name.raw };
  }
  return best;
}

/**
 * Whether a candidate's trading names actively disagree with the permit's business name.
 *
 * Only a candidate that *has* a trading name can contradict one. A licensee who trades under
 * their own name has nothing to compare, so the surname key stands on its own; that is the
 * common `SMITH, JOHN (CCC)` shape and it must keep matching.
 */
function contradictsBusinessName(permitBusiness: NormalizedName, licensee: Licensee): boolean {
  const permitDistinctive = permitBusiness.tokens.filter(isDistinctiveToken);
  if (permitDistinctive.length === 0) return false;

  const tradingNames = licensee.licenceRecords
    .map((record) => record.businessName)
    .filter((value): value is string => value !== null);
  if (tradingNames.length === 0) return false;

  for (const raw of tradingNames) {
    const normalized = normalizeBusinessName(raw, { truncatedInput: false });
    if (normalized.tokens.some((token) => permitDistinctive.includes(token))) return false;
  }
  return true;
}

function emptyMatch(
  contractor: PermitContractor,
  parsed: ReturnType<typeof parseContractorName>,
  permitKey: string,
  truncated: boolean,
): ContractorLicenceMatch {
  return {
    permitContractorName: contractor.name,
    permitContractorKey: permitKey,
    permitNameTruncated: truncated,
    permitQualifier: parsed.hasQualifier
      ? {
          surname: parsed.surname,
          licencePrefix: parsed.licencePrefix,
          licenceSerial: parsed.licenceSerial,
        }
      : null,
    permitCount: contractor.permitCount ?? null,
    matched: false,
    matchTier: null,
    confidence: 0,
    keyedMatch: false,
    runnerUpCount: 0,
    licenceNumber: null,
    licenceType: null,
    licenseeName: null,
    licenceBusinessName: null,
    standing: null,
    adverse: null,
    primaryStatus: null,
    secondaryStatus: null,
    expirationDate: null,
    city: null,
    countyCode: null,
    allLicenceNumbers: [],
    worstStanding: null,
    sourceUrl: null,
    fetchedAt: null,
  };
}

function decide(
  base: ContractorLicenceMatch,
  entity: MatchEntity,
  tier: MatchTier,
  confidence: number,
  runnerUpCount: number,
  /**
   * The licence to report, when the permit named a specific one.
   *
   * Otherwise the licensee's best-standing licence is the headline, which is the right default
   * for a name match — but wrong when the permit stated a serial. `LUNDBERG, DAVID C (1325941)`
   * holds both `CBC017995` and `CCC1325941`; reporting the better-standing `CBC` would answer
   * a question the permit did not ask, and would show the wrong licence's expiry.
   */
  headlineOverride?: LicenceRecord,
): ContractorLicenceMatch {
  const { headline: bestStanding, worst } = standings(entity);
  const headline = headlineOverride ?? bestStanding;
  return {
    ...base,
    matched: true,
    matchTier: tier,
    confidence: Number(Math.min(confidence, 1).toFixed(4)),
    keyedMatch: KEYED_MATCH_TIERS.has(tier),
    runnerUpCount,
    licenceNumber: headline.licenceNumber,
    licenceType: headline.licenceType,
    licenseeName: headline.licenseeName,
    licenceBusinessName: headline.businessName,
    standing: headline.standing,
    adverse: headline.adverse,
    primaryStatus: headline.primaryStatus,
    secondaryStatus: headline.secondaryStatus,
    expirationDate: headline.expirationDate,
    city: headline.city,
    countyCode: headline.countyCode,
    allLicenceNumbers: entity.licenceRecords
      .map((record) => record.licenceNumber)
      .filter((value): value is string => value !== null),
    worstStanding: worst,
    sourceUrl: headline.sourceUrl,
    fetchedAt: headline.fetchedAt,
  };
}

export function matchContractor(
  contractor: PermitContractor,
  index: LicenceIndex,
  options: { floor?: number } = {},
): ContractorLicenceMatch {
  const floor = options.floor ?? MATCH_CONFIDENCE_FLOOR;
  const parsed = parseContractorName(contractor.name, index.licencePrefixes);
  const businessTruncated = !nameSurvivedTruncation(contractor.name);
  const permitBusiness = normalizeBusinessName(parsed.businessPart, {
    truncatedInput: businessTruncated,
  });
  const base = emptyMatch(contractor, parsed, permitBusiness.key, businessTruncated);

  // --- 1. A licence serial stated outright. Nothing outranks it. ---
  if (parsed.licenceSerial !== null) {
    const serial = stripLeadingZeros(parsed.licenceSerial);
    const candidates = index.bySerial.get(serial) ?? [];
    const byPrefix =
      parsed.licencePrefix === null
        ? candidates
        : candidates.filter((licensee) =>
            licensee.licenceRecords.some(
              (record) => record.licenceType === parsed.licencePrefix,
            ),
          );
    const pool = byPrefix.length > 0 ? byPrefix : candidates;
    /** The specific licence the serial names, rather than the licensee's best one. */
    const namedLicence = (licensee: Licensee): LicenceRecord | undefined =>
      licensee.licenceRecords.find(
        (record) =>
          serialOf(record) === serial &&
          (parsed.licencePrefix === null || record.licenceType === parsed.licencePrefix),
      );

    if (pool.length === 1) {
      const licensee = pool[0] as Licensee;
      return decide(base, licensee, 'licence_number', 1, 0, namedLicence(licensee));
    }
    /**
     * A serial is not unique on its own — 124,550 distinct serials back 144,433 licence
     * numbers, so the same digits recur under different prefixes. With several candidates and
     * no prefix to separate them, the permit's own surname breaks the tie; `LUNDBERG, DAVID C
     * (1325941)` is both a serial and a person, and the two agreeing is strong evidence.
     */
    if (pool.length > 1) {
      const person = parsePersonName(contractor.name);
      const agreeing = person
        ? pool.filter((licensee) => licensee.surname === person.surname)
        : [];
      if (agreeing.length === 1) {
        const licensee = agreeing[0] as Licensee;
        return decide(
          base,
          licensee,
          'licence_number',
          1,
          pool.length - 1,
          namedLicence(licensee),
        );
      }
    }
  }

  // --- 2 & 3. The qualifier parenthetical: surname, optionally with a licence prefix. ---
  if (parsed.surname !== null) {
    const surname = parsed.surname;
    const matchesSurname = (licensee: Licensee): boolean => {
      if (licensee.surname === null) return false;
      /**
       * A surname the 30-character column cut is compared as a prefix — `CCC-HARRIS` may be
       * Harris or Harrison — and a prefix match alone is never enough to claim a match, so
       * it always has to pass through the uniqueness or corroboration gate below.
       */
      return parsed.surnameTruncated
        ? licensee.surname.startsWith(surname)
        : licensee.surname === surname;
    };

    let candidates: Licensee[];
    if (parsed.licencePrefix !== null && !parsed.surnameTruncated) {
      candidates = index.bySurnameAndPrefix.get(`${surname}|${parsed.licencePrefix}`) ?? [];
    } else if (parsed.surnameTruncated) {
      /**
       * A cut surname needs a prefix search, so the *distinct surnames* are scanned rather than
       * the licensees. There are far fewer of the former, which keeps this affordable even when
       * the index covers more than one county.
       */
      candidates = [];
      for (const [indexed, licensees] of index.bySurname) {
        if (indexed.startsWith(surname)) candidates.push(...licensees);
      }
    } else {
      candidates = (index.bySurname.get(surname) ?? []).filter(matchesSurname);
      if (parsed.licencePrefix !== null) {
        const narrowed = candidates.filter((licensee) =>
          licensee.licenceRecords.some((record) => record.licenceType === parsed.licencePrefix),
        );
        if (narrowed.length > 0) candidates = narrowed;
      }
    }

    if (candidates.length === 1 && !parsed.surnameTruncated) {
      /**
       * Exactly one licensee in the county answers to this surname and licence prefix. The
       * permit stated both, so this is a keyed lookup that happened to resolve uniquely —
       * `JTO CONTRACTING INC (HOOD CCC)`, `DEHLINGER LLC (CCC DEHLINGER)`.
       *
       * Unless the business name says otherwise. A parenthetical is not guaranteed to hold a
       * surname: `AAGAARD-JUERGENSEN (ROBERT) LL` carries a *given* name, and because exactly
       * one metro licensee is surnamed Robert, the uniqueness rule confidently returned their
       * company, `WOOD CRAFT`. So when the permit's business part is itself distinctive and
       * the candidate trades under names that share none of it, the surname is treated as
       * unreliable and the name tier decides instead — which resolves that permit to the
       * `AAGAARD-JUERGENSEN INC` that is written on its face.
       */
      const sole = candidates[0] as Licensee;
      if (!contradictsBusinessName(permitBusiness, sole)) {
        return decide(base, sole, 'qualifier_unique', 0.97, 0);
      }
    }

    if (candidates.length > 0) {
      const scored = candidates
        .map((licensee) => ({ licensee, corroborated: corroboration(permitBusiness, licensee) }))
        .filter(
          (entry): entry is { licensee: Licensee; corroborated: { score: number; matchedName: string } } =>
            entry.corroborated !== null,
        )
        .sort((left, right) => right.corroborated.score - left.corroborated.score);

      if (scored.length > 0) {
        const winner = scored[0] as { licensee: Licensee; corroborated: { score: number } };
        return decide(
          base,
          winner.licensee,
          'qualifier_corroborated',
          // Shaded by the name agreement that corroborated it, and floored above the fuzzy
          // tiers because the surname key is real evidence on top of the name overlap.
          Math.max(0.85, Math.min(0.95, winner.corroborated.score)),
          scored.length - 1,
        );
      }
      /**
       * Several licensees share the surname and none corroborates on a distinctive token, so
       * no claim is made. This is the case that produced the false positives quoted on
       * `corroboration` above, and falling through to the fuzzy tiers is the honest outcome.
       */
    }
  }

  // --- 4. The permit names an individual, in DBPR's own `LAST, FIRST` convention. ---
  if (looksLikeIndividual(contractor.name)) {
    const person = parsePersonName(contractor.name);
    if (person) {
      const candidates = index.byPerson.get(`${person.surname}|${person.given}`) ?? [];
      if (candidates.length === 1) {
        return decide(base, candidates[0] as Licensee, 'individual_name', 0.95, 0);
      }
      if (candidates.length > 1) {
        // Two different licensed people with the same surname and given name; a middle
        // initial is not enough to separate them, so this is reported rather than guessed.
        const scored = candidates
          .map((licensee) => ({ licensee, corroborated: corroboration(permitBusiness, licensee) }))
          .filter((entry) => entry.corroborated !== null);
        if (scored.length === 1) {
          return decide(
            base,
            (scored[0] as { licensee: Licensee }).licensee,
            'individual_name',
            0.9,
            candidates.length - 1,
          );
        }
      }
    }
    /**
     * A `QB` row holds its business name in the licensee column, so a permit name like
     * `PARKER ROOFS, LLC` — a business whose comma is punctuation — resolves here.
     */
    const asBusiness = index.byPerson.get(`BUSINESS|${permitBusiness.key}`) ?? [];
    if (asBusiness.length === 1) {
      return decide(base, asBusiness[0] as Licensee, 'individual_name', 0.95, 0);
    }
  }

  /**
   * --- 5. Business-name similarity. The BBB tier's rules, applied to DBPR names. ---
   *
   * Skipped for permit names shaped like a person. Tier 4 is the only honest way to resolve
   * one, and when it declines, similarity against *business* names has nothing left to work
   * with but the given name — which scored `ORIE, THOMAS A` against `PARRISH, THOMAS A` at
   * 0.65 purely on `THOMAS`. A first name is not an identifying token.
   */
  if (looksLikeIndividual(contractor.name)) return base;

  let best: { business: Business; score: number; prefixContinuation: boolean } | null = null;
  let aboveFloor = 0;
  for (const business of blockedCandidates(index, permitBusiness) ?? index.businesses) {
    let bestForBusiness: { score: number; prefixContinuation: boolean } | null = null;
    for (const name of business.names) {
      const scored = similarity(permitBusiness, name.normalized);
      if (!bestForBusiness || scored.score > bestForBusiness.score) bestForBusiness = scored;
    }
    if (!bestForBusiness) continue;
    if (bestForBusiness.score >= floor) aboveFloor += 1;
    const better =
      best === null ||
      bestForBusiness.score > best.score ||
      (bestForBusiness.score === best.score && nearestFirst(business) < nearestFirst(best.business));
    if (better) {
      best = {
        business,
        score: bestForBusiness.score,
        prefixContinuation: bestForBusiness.prefixContinuation,
      };
    }
  }

  if (!best || best.score < floor) {
    return { ...base, confidence: best ? Number(best.score.toFixed(4)) : 0 };
  }

  const tier: MatchTier =
    best.score >= 1
      ? 'business_exact'
      : best.prefixContinuation
        ? 'business_truncated_prefix'
        : 'business_strong';

  /**
   * A business can be qualified by several people holding different licences, and when the
   * permit named one of them the headline should be theirs. `RLH CONSTRUCTION (HILLERY CBC)`
   * resolved to the right business and then reported `BOLLI, ORLANDO ROBERT`'s `CPC` — a
   * *plumbing* licence — because that row sorted best. The permit said `CBC`, so it is
   * answerable directly.
   */
  const named = namedQualifierLicence(best.business, parsed.surname, parsed.licencePrefix);
  return decide(base, best.business, tier, best.score, Math.max(0, aboveFloor - 1), named);
}

/** The business's licence held by the qualifier the permit named, if it names one. */
function namedQualifierLicence(
  business: Business,
  surname: string | null,
  licencePrefix: string | null,
): LicenceRecord | undefined {
  if (surname === null && licencePrefix === null) return undefined;
  const bySurname =
    surname === null
      ? business.licenceRecords
      : business.licenceRecords.filter((record) => record.qualifierSurname === surname);
  if (bySurname.length === 0) return undefined;
  if (licencePrefix === null) return bySurname[0];
  return bySurname.find((record) => record.licenceType === licencePrefix) ?? bySurname[0];
}

export function matchContractors(
  contractors: readonly PermitContractor[],
  index: LicenceIndex,
  options: { floor?: number } = {},
): ContractorLicenceMatch[] {
  return contractors.map((contractor) => matchContractor(contractor, index, options));
}

export function matchTierCounts(
  matches: readonly ContractorLicenceMatch[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of matches) {
    const key = match.matched ? (match.matchTier as string) : 'unmatched';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Licence serials referenced outright by permit contractor names.
 *
 * Collected *before* the extract is parsed so the parse pass can retain the handful of
 * out-of-county rows those serials name while discarding the rest of the state. A contractor
 * who pulls Seminole permits need not hold a Seminole-registered licence —
 * `NOLANDS ROOFING (CCC-1335461)` is registered in Lake County — and a county filter alone
 * would drop them. An explicit licence serial is not made wrong by the licensee's address,
 * so it is the one key worth reaching outside the county for.
 */
export function referencedSerials(
  contractors: readonly PermitContractor[],
  licencePrefixes: ReadonlySet<string>,
): Set<string> {
  const serials = new Set<string>();
  for (const contractor of contractors) {
    const parsed = parseContractorName(contractor.name, licencePrefixes);
    if (parsed.licenceSerial !== null) serials.add(stripLeadingZeros(parsed.licenceSerial));
  }
  return serials;
}

/** Prefixes needed before the data is loaded, to find serials in qualifier parentheticals. */
export const QUALIFIER_SEED_PREFIXES: ReadonlySet<string> = new Set([
  'CCC',
  'CGC',
  'CBC',
  'CRC',
  'CAC',
  'CFC',
  'CPC',
  'CMC',
  'CUC',
  'CVC',
  'CSC',
  'SCC',
  'PCC',
  'FRO',
  QUALIFIED_BUSINESS_PREFIX,
]);
