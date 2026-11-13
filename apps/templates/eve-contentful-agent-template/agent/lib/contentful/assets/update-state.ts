/* Session persistence adapter for asset-backed field updates. Creation receipts are separate. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { JsonValue } from "../../json";
import { defineState } from "../../state";
import { configurationKey } from "../config";
import { contentfulAssetUpdateInputSchema } from "../input-schemas";
import { contentLocale } from "../locale";
import { updateContentfulFields } from "../update";
import type { ReadAssetFile } from "./files";
import {
  contentfulAssetUpdateResult,
  executeContentfulAssetUpdate,
  prepareContentfulAssetUpdate,
} from "./update";
import type { ContentfulAssetUpdatePlan } from "./update";

const updates = defineState<Record<string, ContentfulAssetUpdatePlan>>(
  "contentful.asset-updates",
  () => ({})
);

/**
 * Routes ordinary updates directly and persists asset-backed updates for explicit recovery.
 *
 * @param input - Tool input parsed against the asset-update schema.
 * @param sessionId - Session identity used to isolate and derive recovery IDs.
 * @param callId - Tool call identity used to make initial replay idempotent.
 * @param signal - Cancellation signal for preparation and execution.
 * @param readFile - Optional sandbox reader for staged image attachments.
 * @returns Ordinary update results or durable asset-backed recovery receipts.
 * @throws {@link Error} When recovery is unknown, inputs changed, or deployment configuration drifted.
 */
export const updateContentfulFieldsWithAssets = async (
  input: JsonValue,
  sessionId: string,
  callId: string,
  signal?: AbortSignal,
  readFile?: ReadAssetFile
): Promise<
  | Awaited<ReturnType<typeof updateContentfulFields>>
  | ReturnType<typeof contentfulAssetUpdateResult>
> => {
  const parsed = contentfulAssetUpdateInputSchema.parse(input);
  if (parsed.assets === null && parsed.resumeFrom === null) {
    return updateContentfulFields(
      { entries: parsed.entries, space: parsed.space },
      signal
    );
  }
  if (!(sessionId && callId)) {
    throw new Error("Asset-backed updates require a session and tool call ID.");
  }
  const recoveryId =
    parsed.resumeFrom ??
    `contentful-update-${createHash("sha256")
      .update(JSON.stringify([sessionId, callId]))
      .digest("hex")
      .slice(0, 32)}`;
  let plan = updates.get()[recoveryId];
  if (parsed.resumeFrom && !plan) {
    throw new Error(
      "Unknown update recoveryId in this session. Inspect previously returned IDs; do not upload replacements."
    );
  }
  if (plan && !isDeepStrictEqual(plan.input, { ...parsed, resumeFrom: null })) {
    throw new Error(
      "Recovery inputs differ from the saved update. Use identical inputs. For version conflicts, read and reassess with existing Asset IDs in an ordinary update."
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
    return contentfulAssetUpdateResult(plan);
  }
  const save = (value: ContentfulAssetUpdatePlan) =>
    updates.update((current) => ({
      ...current,
      [recoveryId]: structuredClone(value),
    }));
  if (!plan) {
    plan = await prepareContentfulAssetUpdate(parsed, recoveryId, signal);
    save(plan);
  }
  return executeContentfulAssetUpdate(
    structuredClone(plan),
    save,
    signal,
    readFile
  );
};
