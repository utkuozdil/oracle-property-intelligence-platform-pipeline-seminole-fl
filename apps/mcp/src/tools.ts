import { z } from 'zod';
import type { OrderKey, PropertyFilters } from './filters';
import { ORDER_BY } from './filters';
import type { OracleDataset, Row } from './queries';

/**
 * The tool surface.
 *
 * Five tools, deliberately. The temptation with a Parquet file and a SQL engine is to
 * expose "run this SQL", which is powerful, unbounded and impossible to describe
 * honestly in a tool description. These five name the questions the roofing CRM asks and
 * each one maps onto columns that are already published — no new export, no reshaped
 * table. The SQL shape is documented instead, in `docs/seminole-mcp-access.md`, for a
 * consumer who wants to skip the server entirely and point DuckDB at the same URL.
 *
 * JSON Schema for each tool is generated from the same Zod schema that validates the
 * call, so an argument an agent is told about is an argument the server accepts.
 */

const filterShape = {
  minRoofAge: z
    .number()
    .int()
    .optional()
    .describe('Minimum roof age in years (proxy: see assumptions).'),
  maxRoofAge: z.number().int().optional(),
  minYearBuilt: z.number().int().optional(),
  maxYearBuilt: z.number().int().optional(),
  jurisdiction: z
    .string()
    .optional()
    .describe('City or "UNINCORPORATED"; matched case-insensitively as a substring.'),
  propertyType: z.string().optional(),
  addressContains: z.string().optional(),
  ownerNameContains: z.string().optional(),
  minJustValue: z.number().optional(),
  maxJustValue: z.number().optional(),
  soldBefore: z.string().optional().describe('ISO date; last sale strictly before it.'),
  soldAfter: z.string().optional().describe('ISO date; last sale strictly after it.'),
  minYearsSinceSale: z.number().int().optional(),
  ownerOutOfArea: z.boolean().optional().describe('Owner mailing address outside the county.'),
  hasBuilding: z.boolean().optional(),
  hasPool: z.boolean().optional(),
};

const describeInput = z.object({}).describe('No arguments.');

const getPropertyInput = z.object({
  parcelId: z.string().min(1).describe('County appraiser parcel id, e.g. 15-21-29-527-0000-0140.'),
});

const searchInput = z.object({
  ...filterShape,
  orderBy: z
    .enum(Object.keys(ORDER_BY) as [OrderKey, ...OrderKey[]])
    .optional()
    .describe('Default roof_age_desc.'),
  limit: z.number().int().positive().optional().describe('Default 25.'),
});

const nearInput = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMiles: z.number().positive().max(100),
  ...filterShape,
  limit: z.number().int().positive().optional().describe('Default 25.'),
});

const leadsInput = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMiles: z.number().positive().max(100).describe('Search radius around the pin.'),
  minRoofAge: z
    .number()
    .int()
    .optional()
    .describe('Optional roof-age floor. Omit for the open-permit question; it does not require an aged roof.'),
  minPermitOpenYears: z
    .number()
    .optional()
    .describe('How long a permit must have been open to count as "many years". Default 3.'),
  limit: z.number().int().positive().optional().describe('Default 25.'),
});

function pickFilters(input: Record<string, unknown>): PropertyFilters {
  const filters: Record<string, unknown> = {};
  for (const key of Object.keys(filterShape)) {
    if (input[key] !== undefined) filters[key] = input[key];
  }
  return filters as PropertyFilters;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  schema: z.ZodType;
  run: (dataset: OracleDataset, input: Record<string, unknown>) => Promise<Row>;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'describe_dataset',
    title: 'Describe the published Seminole County dataset',
    description:
      'What is published, how fresh it is, which IPFS CID is being read, and what is NOT in it. ' +
      'Call this first: it states up front that permit history and BBB ratings are absent from ' +
      'the IPFS query table unless this server was pointed at the published S3 permit snapshot, ' +
      'so an empty permit result is never mistaken for "no permits".',
    schema: describeInput,
    run: (dataset) => dataset.describeDataset(),
  },
  {
    name: 'get_property',
    title: 'Get one property by parcel id',
    description:
      'Every published column for a single parcel: owner, address, values, sale history, ' +
      'building characteristics, coordinates, derived roof age and jurisdiction.',
    schema: getPropertyInput,
    run: (dataset, input) => dataset.getProperty(String(input.parcelId)),
  },
  {
    name: 'search_properties',
    title: 'Search properties by attribute',
    description:
      'Filtered search over all 181,218 published parcels — roof age, year built, jurisdiction, ' +
      'value, last sale, owner-out-of-area, pool, property type. Returns a summary projection ' +
      'plus the total match count, so a broad filter reports its own breadth instead of ' +
      'silently truncating.',
    schema: searchInput,
    run: (dataset, input) =>
      dataset.searchProperties({
        filters: pickFilters(input),
        orderBy: input.orderBy as OrderKey | undefined,
        limit: input.limit as number | undefined,
      }),
  },
  {
    name: 'search_properties_near',
    title: 'Search properties within a radius of a point',
    description:
      'The same filters, constrained to a radius around a latitude/longitude pin — the shape a ' +
      'CRM map click produces. Results are ordered by distance and carry miles_from_pin.',
    schema: nearInput,
    run: (dataset, input) =>
      dataset.searchNear({
        latitude: Number(input.latitude),
        longitude: Number(input.longitude),
        radiusMiles: Number(input.radiusMiles),
        filters: pickFilters(input),
        limit: input.limit as number | undefined,
      }),
  },
  {
    name: 'find_roofing_leads',
    title: 'Roofing leads near a point, with permit and contractor evidence',
    description:
      'Answers the composite question: which properties near this area have confirmed-open ' +
      'roofing permits that have stayed open for years, and who is the listed contractor (with a ' +
      'BBB rating where the snapshot has one). Status "unknown" is not treated as open. Permit ' +
      'and BBB columns are NOT in the IPFS query table; when this server has no snapshot pointer ' +
      'the response says the permit half is unanswered and returns aged-roof candidates instead ' +
      'of an empty list.',
    schema: leadsInput,
    run: (dataset, input) =>
      dataset.findRoofingLeads({
        latitude: Number(input.latitude),
        longitude: Number(input.longitude),
        radiusMiles: Number(input.radiusMiles),
        minRoofAge: input.minRoofAge as number | undefined,
        minPermitOpenYears: (input.minPermitOpenYears as number | undefined) ?? 3,
        limit: input.limit as number | undefined,
      }),
  },
];

export function jsonSchemaFor(tool: ToolDefinition): Record<string, unknown> {
  return z.toJSONSchema(tool.schema, { io: 'input', target: 'draft-7' }) as Record<string, unknown>;
}
