import { SandboxKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import type { SessionStepState } from "#execution/publish-session-events.js";
import { hydrateDurableSession } from "#execution/session.js";
import { withSessionStateDelta } from "#execution/session/state-delta.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

/** Runs only in the sandbox owner's sequential session workflow. */
export async function initializeOwnerSandboxStep(input: SessionStepState) {
  "use step";
  return await withSessionStateDelta(input, async (current) => {
    const durable = readDurableSession(current.sessionState);
    if (durable.sandboxState?.session != null) {
      return { sandboxState: durable.sandboxState };
    }
    const ctx = await deserializeContext(current.serializedContext);
    const bundle = ctx.require(BundleKey);
    if (bundle.graph.root.sandboxRegistry.sandbox.definition.kind === "parent") {
      throw new Error(
        "Sandbox initialization was addressed to an inheriting session, not its owner.",
      );
    }
    const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
    const session = hydrateDurableSession({
      compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
      durable,
      turnAgent: effectiveAgent.turnAgent,
    });
    const scoped = await withContextScope(ctx, session, async (owner) => {
      await ctx.require(SandboxKey).get();
      return { result: undefined, session: owner };
    });
    const sandboxState = scoped.session.sandboxState;
    if (sandboxState?.session == null) {
      throw new Error("The sandbox owner did not initialize a sandbox for its child.");
    }
    return {
      sandboxState,
      serializedContext: serializeContext(ctx),
      sessionState: createDurableSessionState({ session: scoped.session }),
    };
  });
}
