// Force the `__builtin_set_attributes` step to register itself when the
// emit helper is loaded. The workflow-body shim's
// `experimental_setAttributes` dispatches `__builtin_set_attributes` via
// the runtime step registry; if no module ever imports the builtins file
// (e.g. in integration tests that bypass the Nitro entry), the dispatch
// fails with "Step '__builtin_set_attributes' is not registered". Side
// effect import is the smallest change that keeps the contract intact.
import "#internal/workflow/builtins.js";

import { normalizeEveAttributes, type EveAttributeValue } from "#runtime/attributes/normalize.js";

export {
  EVE_ATTRIBUTE_VALUE_MAX_BYTES,
  type EveAttributeValue,
  truncateForTag,
} from "#runtime/attributes/normalize.js";

/**
 * Per-process flag: once we've warned about a tag write failure we
 * stop warning to avoid drowning logs when the workflow runtime is
 * misconfigured or the world adapter is missing
 * `experimentalSetAttributes`. Mirrors the SDK's own one-shot warning
 * for unsupported worlds in `experimental_setAttributes`.
 */
let WARNED_ABOUT_TAG_FAILURE = false;

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
  const normalized = normalizeEveAttributes(attrs);

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
