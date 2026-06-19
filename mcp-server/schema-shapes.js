// Curated enums for typed tool inputs, mirroring the v76 dashboard schema.
//
// These are intentionally STATIC rather than derived from a live schema fetch.
// Building zod enums from a fetched schema would force a daemon cold start
// during tools/list, which would break the "instant listing, lazy ensureReady"
// property the read/lifecycle tools rely on. The daemon runs ajv against the
// real schema on every write, so that is the actual gate; these enums only
// give the agent friendlier, self-documenting inputs and reject obvious typos
// before a round trip.
//
// If the dashboard schema version bumps and these drift, the daemon still
// rejects bad values; update these to match when convenient.

import { z } from 'zod';

// parameter.json kind enum (v76 schema/76/parameter.json).
export const PARAMETER_KINDS = [
  'string',
  'real',
  'decimal',
  'int',
  'bool',
  'datetime',
  'long',
  'duration',
  'dataSource',
];

// parameter.json selectionType enum.
export const SELECTION_TYPES = ['freetext', 'scalar', 'array'];

// dataSource.json kind discriminator (top-level dataSources[] entries).
export const DATASOURCE_KINDS = ['manual-kusto', 'kusto-trident'];

export const parameterKind = () => z.enum(PARAMETER_KINDS);
export const selectionType = () => z.enum(SELECTION_TYPES);

// visualType is deliberately a free string. The dashboard JSON schema leaves it
// open (the app, not the schema, enforces the visual whitelist), so an enum
// here would be a guess that could reject valid future visuals. Describe the
// common values instead and let the daemon's tile guards do the real checking.
export const visualType = () =>
  z
    .string()
    .describe(
      'Tile visual type, e.g. "table", "barchart", "linechart", "timechart", "piechart", "card", "stat", "markdownCard". Use "markdownCard" for a text tile.'
    );
