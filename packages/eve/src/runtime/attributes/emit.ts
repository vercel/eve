// Force the `__builtin_set_attributes` step to register itself when the
// emit helper is loaded. The workflow-body shim's
// `experimental_setAttributes` dispatches `__builtin_set_attributes` via
// the runtime step registry; if no module ever imports the builtins file
// (e.g. in integration tests that bypass the Nitro entry), the dispatch
// fails with "Step '__builtin_set_attributes' is not registered". Side
// effect import is the smallest change that keeps the contract intact.
import "#internal/workflow/builtins.js";

/**
 * Maximum byte size for an attribute value on a workflow run.
 *
 * Local mirror of `ATTRIBUTE_VALUE_MAX_BYTES` from `@workflow/world`
 * (source of truth: `packages/world/src/attributes.ts` in the workflow
 * repo). The value is duplicated rather than imported because
 * `@workflow/core` — the only workflow surface bundled into the
 * workflow body — does not re-export it, and pulling `@workflow/world`
 * into the body bundle would drag in the full zod attribute validator
 * (the same reason `workflow-core-shim.ts` skips runtime validation in
 * its `experimental_setAttributes`).
 *
 * Strings emitted through {@link setEveAttributes} are truncated to this
 * byte count before they reach the runtime so the validator never
 * rejects a tag for length alone.
 *
 * Drift is conservative-by-construction: if workflow LOWERS the limit,
 * over-long values are rejected and `setEveAttributes` swallows the
 * failure (warn-once-per-process) — dashboards see a missing tag, never
 * a broken agent; if workflow RAISES it, titles are merely shorter than
 * necessary. `emit.drift.test.ts` asserts equality against the real
 * `@workflow/world` export (a devDependency) so CI fails loudly the day
 * the constants diverge.
 */
export const EVE_ATTRIBUTE_VALUE_MAX_BYTES = 256;

/**
 * Attribute value the caller wants to write. `undefined` values are
 * stripped before the runtime call; numbers are stringified; strings
 * are truncated to {@link EVE_ATTRIBUTE_VALUE_MAX_BYTES}.
 */
export type EveAttributeValue = string | number | undefined;

/**
 * Per-process flag: once we've warned about a tag write failure we
 * stop warning to avoid drowning logs when the workflow runtime is
 * misconfigured or the world adapter is missing
 * `experimentalSetAttributes`. Mirrors the SDK's own one-shot warning
 * for unsupported worlds in `experimental_setAttributes`.
 */
let WARNED_ABOUT_TAG_FAILURE = false;

/**
 * Truncates a string so its UTF-8 byte length is at most `maxBytes`
 * without splitting a multi-byte character.
 *
 * The workflow runtime measures attribute values in UTF-8 bytes, not
 * code units, so `value.slice(0, maxBytes)` is not safe — a JS string
 * with two-byte characters (e.g. emoji surrogate pairs) can serialize
 * to twice as many bytes as code units. We re-encode the truncated
 * candidate after each drop and shrink one code unit at a time when
 * the candidate's last character straddles the byte budget.
 */
export function truncateForTag(value: string, maxBytes = EVE_ATTRIBUTE_VALUE_MAX_BYTES): string {
  if (maxBytes <= 0) {
    return "";
  }

  const encoder = new TextEncoder();
  const fullBytes = encoder.encode(value);
  if (fullBytes.length <= maxBytes) {
    return value;
  }

  // Walk back one code unit at a time, but never stop on a position
  // that would leave a lone high surrogate at the tail — `slice` is
  // code-unit based, so slicing between the two halves of a surrogate
  // pair would otherwise produce a malformed string that TextEncoder
  // emits as the 3-byte U+FFFD replacement character.
  let end = value.length;
  while (end > 0) {
    const lastCharCode = value.charCodeAt(end - 1);
    const endsOnHighSurrogate = lastCharCode >= 0xd800 && lastCharCode <= 0xdbff;
    if (endsOnHighSurrogate) {
      end -= 1;
      continue;
    }
    const candidate = value.slice(0, end);
    if (encoder.encode(candidate).length <= maxBytes) {
      return candidate;
    }
    end -= 1;
  }
  return "";
}

/**
 * Writes a batch of eve-owned attributes to the active workflow run.
 *
 * Reserved-namespace contract:
 * - All keys must use the `$eve.` prefix (the workflow runtime would
 *   otherwise reject them as user-space writes into the reserved `$`
 *   namespace).
 * - The call always opts in via `{ allowReservedAttributes: true }`
 *   on behalf of the framework — authored code never calls this helper
 *   directly.
 *
 * Value normalization:
 * - `undefined` entries are dropped so callers can build attribute
 *   maps with optional fields (`$eve.subagent` is only present on
 *   subagent roots, for example).
 * - Numbers are stringified (the runtime stores all values as strings).
 * - Strings are truncated to {@link EVE_ATTRIBUTE_VALUE_MAX_BYTES} via
 *   {@link truncateForTag} so a long free-form value (e.g. `$eve.title`)
 *   can never trip the runtime's per-value byte budget.
 *
 * Failure policy: tag writes are observability metadata, not load-bearing
 * state. A failure inside the runtime (transient network, schema bug,
 * missing world adapter) is logged once per process and then swallowed
 * so the eve session it tagged is unaffected.
 *
 * Must be called from inside a `"use workflow"` or `"use step"` body —
 * the runtime throws a `FatalError` outside those contexts.
 */
export async function setEveAttributes(attrs: Record<string, EveAttributeValue>): Promise<void> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) {
      continue;
    }
    const stringValue = typeof value === "number" ? String(value) : value;
    normalized[key] = truncateForTag(stringValue);
  }

  if (Object.keys(normalized).length === 0) {
    return;
  }

  try {
    // Import `@workflow/core` dynamically (matching `workflow-steps.ts`,
    // `turn-workflow.ts`, etc.). A static import here would pull the
    // compiled core into emit.js's static graph and defeat the dynamic
    // chunking those modules rely on — the build emits an
    // `INEFFECTIVE_DYNAMIC_IMPORT` warning and `bin-build-output` fails.
    const { experimental_setAttributes } = await import("#compiled/@workflow/core/index.js");
    await experimental_setAttributes(normalized, { allowReservedAttributes: true });
  } catch (error) {
    if (!WARNED_ABOUT_TAG_FAILURE) {
      WARNED_ABOUT_TAG_FAILURE = true;
      console.warn("[eve] setEveAttributes failed; suppressing further warnings this process.", {
        keys: Object.keys(normalized),
        error: (error as Error).message,
      });
    }
  }
}
