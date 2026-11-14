import { BRAND_CONTEXT_PREFIX } from "#lib/vercel-blob/config.js";

/**
 * Storage location and size bound for the team's shared brand context document.
 *
 * @remarks
 * The prefix comes from the Blob namespace registry rather than being declared here, so the asset
 * tools' guards and this module can't drift apart: if the prefix moves, the guard moves with it.
 *
 * @packageDocumentation
 */

/**
 * The single Blob key backing the brand context document.
 *
 * @remarks
 * A constant rather than a per-principal derivation, unlike user preferences: brand context
 * describes the product and its voice, so every member of the team and every specialist subagent
 * reads and writes the same document.
 */
export const BRAND_CONTEXT_KEY = `${BRAND_CONTEXT_PREFIX}brand.md`;

/**
 * Maximum size of the brand context document, in characters.
 *
 * @remarks
 * Every specialist loads this at the start of a task, so its size is paid for on each delegation.
 * The bound keeps it a briefing rather than an archive; long-form source material belongs in the
 * asset store or the team's own docs.
 */
export const MAX_BRAND_CONTEXT_LENGTH = 20_000;
