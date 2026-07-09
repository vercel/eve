/**
 * Bridges a delegated subagent's terminal outcome back to its parent
 * driver via the subagent-result hook. Pure projection helpers live
 * in `delegated-parent-result.ts` so the workflow step-proxy transform
 * doesn't strip them from this file.
 */

import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import {
  type RuntimeInheritedSandboxResult,
  type RuntimeSubagentResultActionResult,
} from "#runtime/actions/types.js";
import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/**
 * Resumes the parent driver's hook with a delegated subagent result.
 * No-op for root sessions.
 *
 * `usage` — the completed child's session-total token spend — is
 * attached to success results so the caller can attribute the
 * subagent's tokens. Error results never carry usage.
 */
export async function notifyDelegatedParentStep(input: {
  readonly result: RuntimeSubagentResultActionResult | undefined;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState?: DurableSessionState;
  readonly usage?: TokenUsage;
}): Promise<void> {
  "use step";

  if (input.result === undefined) {
    return;
  }

  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.get(ChannelKey);

  if (adapter?.kind !== SUBAGENT_ADAPTER_KIND) {
    return;
  }

  const parentContinuationToken = String(adapter.state?.parentContinuationToken ?? "");
  if (parentContinuationToken === "") {
    return;
  }

  const resultWithUsage =
    input.usage === undefined || input.result.isError === true
      ? input.result
      : { ...input.result, usage: input.usage };
  const result = await attachInheritedSandboxResult({
    adapterState: adapter.state,
    result: resultWithUsage,
    sessionState: input.sessionState,
  });

  await resumeHook(parentContinuationToken, {
    kind: "runtime-action-result",
    results: [result],
  });
}

async function attachInheritedSandboxResult(input: {
  readonly adapterState: Readonly<Record<string, unknown>> | undefined;
  readonly result: RuntimeSubagentResultActionResult;
  readonly sessionState: DurableSessionState | undefined;
}): Promise<RuntimeSubagentResultActionResult> {
  if (input.sessionState === undefined) {
    return input.result;
  }

  const inheritedSandbox = await readInheritedSandboxResult({
    adapterState: input.adapterState,
    sessionState: input.sessionState,
  });

  if (inheritedSandbox === undefined) {
    return input.result;
  }

  return { ...input.result, inheritedSandbox };
}

async function readInheritedSandboxResult(input: {
  readonly adapterState: Readonly<Record<string, unknown>> | undefined;
  readonly sessionState: DurableSessionState;
}): Promise<RuntimeInheritedSandboxResult | undefined> {
  const sandboxSessionId = readNonEmptyString(input.adapterState?.sandboxSessionId);

  if (sandboxSessionId === undefined) {
    return undefined;
  }

  const session = await readDurableSession(input.sessionState);

  if (session.sandboxState === undefined) {
    return undefined;
  }

  const inheritedSandbox: {
    nodeId?: string;
    sessionId: string;
    state: NonNullable<typeof session.sandboxState>;
  } = {
    sessionId: sandboxSessionId,
    state: session.sandboxState,
  };
  const sandboxNodeId = readNonEmptyString(input.adapterState?.sandboxNodeId);

  if (sandboxNodeId !== undefined) {
    inheritedSandbox.nodeId = sandboxNodeId;
  }

  return inheritedSandbox;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
