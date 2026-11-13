import type { JsonValue } from "../json";
import { defineState } from "../state";
import { configurationKey } from "./config";
/**
 * eve session persistence for frozen publication scope, preview delivery, and write progress.
 *
 * @packageDocumentation
 */
import { contentLocale } from "./locale";
import {
  contentfulPublicationFingerprint,
  executeContentfulPublication,
  prepareContentfulPublication,
} from "./publication";
import type {
  ContentfulPublicationOutcome,
  ContentfulPublicationPlan,
} from "./publication";

interface SavedPublication {
  plan: ContentfulPublicationPlan;
  configuration: string;
  locale: string;
  previewMessageId: string | null;
}
// eve checkpoints these per-session plans across approval pauses. Progress is
// checkpointed at step boundaries, not transactionally with Contentful writes.
const plans = defineState<Record<string, SavedPublication>>(
  "contentful.contentful-publication-plans",
  () => ({})
);
const save = (callId: string, plan: ContentfulPublicationPlan) => {
  plans.update((current) => ({
    ...current,
    [callId]: {
      configuration: configurationKey(),
      locale: contentLocale(),
      plan: structuredClone(plan),
      previewMessageId: current[callId]?.previewMessageId ?? null,
    },
  }));
};
const existingPlan = (callId: string, input: JsonValue) => {
  if (!callId) {
    throw new Error("Publishing requires a tool call ID.");
  }
  const fingerprint = contentfulPublicationFingerprint(input);
  const saved = plans.get()[callId];
  if (saved && saved.configuration !== configurationKey()) {
    throw new Error(
      "Contentful configuration changed. Prepare a new publication plan."
    );
  }
  if (saved && saved.plan.inputFingerprint !== fingerprint) {
    throw new Error(
      "Publication input differs from the saved plan. Request a new publication call."
    );
  }
  return saved ? structuredClone(saved) : undefined;
};
/**
 * Reuse the call's frozen plan or prepare and checkpoint one before approval.
 *
 * @param callId - Nonempty tool call ID, unique within the active eve session.
 * @param input - Publication input whose parsed fingerprint binds this call to its scope.
 * @returns A copy of the existing plan, or a newly prepared and saved plan.
 * @throws {@link Error} If input differs from the saved call, preparation fails, or eve state is unavailable.
 * @remarks Uses the current eve session. Repeated evaluation does not reread or expand a saved plan.
 */
export const getOrPrepareContentfulPublication = async (
  callId: string,
  input: JsonValue
): Promise<ContentfulPublicationPlan> => {
  const existing = existingPlan(callId, input);
  if (existing) {
    return existing.plan;
  }
  const plan = await prepareContentfulPublication(input);
  save(callId, plan);
  return plan;
};

/**
 * Read a matching saved approval plan without rebuilding scope.
 *
 * @param callId - Tool call ID owning the plan in the active eve session.
 * @param input - Original publication input, checked against the saved fingerprint.
 * @returns A copy of the frozen plan for preview rendering.
 * @throws {@link Error} If the ID/input is invalid, no matching approval plan exists, or eve state is unavailable.
 */
export const getContentfulPublicationForApproval = (
  callId: string,
  input: JsonValue
): ContentfulPublicationPlan => {
  const saved = existingPlan(callId, input);
  if (!saved?.plan.requiresApproval) {
    throw new Error("No saved publication approval plan exists for this call.");
  }
  return saved.plan;
};

/**
 * Record confirmed preview delivery before approved publication may execute.
 *
 * @param callId - Tool call ID owning the saved plan in the active eve session.
 * @param input - Original publication input, checked against the saved fingerprint.
 * @param messageId - Nonempty ID returned by successful preview delivery.
 * @throws {@link Error} If the ID/input is invalid, the plan or message ID is missing, or eve state is unavailable.
 * @remarks Calling this with an unconfirmed delivery would bypass the execution delivery gate.
 */
export const recordContentfulPublicationPreview = (
  callId: string,
  input: JsonValue,
  messageId: string
): void => {
  const saved = existingPlan(callId, input);
  if (!(saved && messageId)) {
    throw new Error(
      "Cannot record publication preview delivery without a saved plan and message ID."
    );
  }
  plans.update((current) => ({
    ...current,
    [callId]: { ...saved, previewMessageId: messageId },
  }));
};

/**
 * Execute the saved scope, retaining partial results and removing completed plans.
 *
 * @param callId - Tool call ID owning the plan in the active eve session.
 * @param input - Original publication input; changed input requires a new call.
 * @param signal - Cancellation forwarded to frozen-plan verification and execution.
 * @returns Publication outcomes, including previously recorded partial results without retrying.
 * @throws {@link Error} If the input/plan is invalid, required preview delivery is missing, or preflight fails.
 * @throws {@link Error} If session-state access or a progress checkpoint fails.
 * @remarks Requires an active eve context. Caller membership and approval are checked by
 * the tool; this adapter enforces saved scope and delivery, not responder authorization.
 */
export const publishPlannedContentfulEntries = async (
  callId: string,
  input: JsonValue,
  signal?: AbortSignal
): Promise<ContentfulPublicationOutcome> => {
  const saved = existingPlan(callId, input);
  if (!saved) {
    throw new Error(
      "No saved publication plan exists for this call. Request a new publication call."
    );
  }
  if (saved.locale !== contentLocale()) {
    throw new Error(
      "Contentful locale changed. Prepare a new publication plan."
    );
  }
  if (saved.plan.requiresApproval && !saved.previewMessageId) {
    throw new Error("The publication plan has not been shown for approval.");
  }
  const output = await executeContentfulPublication(
    saved.plan,
    (progress) => save(callId, progress),
    signal
  );
  if (output.complete) {
    plans.update((current) => {
      const next = { ...current };
      Reflect.deleteProperty(next, callId);
      return next;
    });
  }
  return output;
};
