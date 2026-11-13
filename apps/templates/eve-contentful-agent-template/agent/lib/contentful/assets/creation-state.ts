import { createHash } from "node:crypto";

import type { JsonValue } from "../../json";
import { defineState } from "../../state";
/**
 * eve session persistence for page and asset-backed creation, replay reporting, and explicit recovery.
 *
 * @packageDocumentation
 */
import { configurationKey } from "../config";
import type { ContentfulCreationResult } from "../create";
import { createContentfulEntry } from "../create";
import { contentfulCreateInputSchema } from "../input-schemas";
import { contentLocale } from "../locale";
import { pageKindInSpace, QUERY_SPACES } from "../model";
import {
  contentfulAssetCreationResult,
  contentfulCreationInputsMatch,
  executeContentfulAssetCreation,
  prepareContentfulAssetCreation,
} from "./creation";
import type {
  ContentfulAssetCreationResult,
  ContentfulAssetCreationPlan,
} from "./creation";
import type { ReadAssetFile } from "./files";

const creations = defineState<Record<string, ContentfulAssetCreationPlan>>(
  "contentful.asset-creations",
  () => ({})
);

/**
 * Create or explicitly recover a page draft or supporting entry within the current eve session.
 *
 * @param input - Creation input; `resumeFrom` selects an existing operation with identical inputs.
 * @param sessionId - Session identity used with the initial call ID to derive a stable recovery ID.
 * @param callId - Current tool call ID; required with the session ID for pages and asset-backed operations.
 * @param signal - Optional cancellation passed to preparation and resource execution.
 * @param readFile - Optional session-scoped attachment reader, supplied by the tool adapter.
 * @returns A direct result for supporting entries without assets, or saved per-resource creation progress.
 * @throws {@link Error} If inputs/IDs are invalid, recovery is unknown or mismatched, or preparation/state access fails.
 * @remarks Page and asset-backed replays with the same initial call ID report saved progress; only
 * `resumeFrom` opts into recovery. Supporting entries without assets delegate directly
 * to creation without a recovery plan. Every page uses saved state. State keys,
 * ID construction, and saved inputs must remain compatible across redeploys.
 * Saved execution reports operation failures in its result.
 */
export const createContentfulEntryWithAssets = async (
  input: JsonValue,
  sessionId: string,
  callId: string,
  signal?: AbortSignal,
  readFile?: ReadAssetFile
): Promise<ContentfulCreationResult | ContentfulAssetCreationResult> => {
  const parsed = contentfulCreateInputSchema.parse(input);
  if (
    parsed.assets === null &&
    parsed.resumeFrom === null &&
    !pageKindInSpace(QUERY_SPACES[parsed.space], parsed.contentTypeId)
  ) {
    return createContentfulEntry(parsed, signal);
  }
  if (!(sessionId && callId)) {
    throw new Error(
      "Recoverable creation requires a session and tool call ID."
    );
  }
  const recoveryId =
    parsed.resumeFrom ??
    `contentful-${createHash("sha256")
      .update(JSON.stringify([sessionId, callId]))
      .digest("hex")
      .slice(0, 32)}`;
  let plan = creations.get()[recoveryId];
  if (parsed.resumeFrom && !plan) {
    throw new Error(
      "Unknown recoveryId in this session. Do not create a replacement; inspect the returned Contentful IDs."
    );
  }
  if (plan && !contentfulCreationInputsMatch(plan.input, parsed)) {
    throw new Error(
      "Recovery inputs differ from the original creation. Use identical fields and assets; do not change the saved operation."
    );
  }
  if (
    plan &&
    (plan.configuration !== configurationKey() ||
      plan.locale !== contentLocale())
  ) {
    throw new Error(
      "Contentful configuration or locale changed. Inspect existing resources before starting a new operation."
    );
  }
  if (plan && parsed.resumeFrom === null) {
    return contentfulAssetCreationResult(plan);
  }
  const save = (value: ContentfulAssetCreationPlan) =>
    creations.update((current) => ({
      ...current,
      [recoveryId]: structuredClone(value),
    }));
  if (!plan) {
    plan = await prepareContentfulAssetCreation(parsed, recoveryId, signal);
    save(plan);
  }
  return executeContentfulAssetCreation(
    structuredClone(plan),
    save,
    signal,
    readFile
  );
};
