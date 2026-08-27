import { createHook } from "#compiled/@workflow/core/index.js";

import type { RuntimeActionResultHookPayload } from "#channel/types.js";
import { isRunEvent, readRunRef, type RunEvent } from "#execution/tool-run/messages.js";
import { resumeHook } from "#execution/tool-run/workflow-api.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import type { ToolContext } from "#tools/definition.js";
import type { RuntimeSubagentResult } from "#shared/action-types.js";

/**
 * The one durable execute body used by every local and remote subagent tool.
 * Admission stays with the owner; this body only owns the child wire and wait.
 */
export async function subagentToolExecuteWorkflow(
  _input: unknown,
  ctx: ToolContext,
): Promise<RuntimeSubagentResult> {
  "use workflow";

  const privateContext = readPrivateContext(ctx);
  const child = createHook<RuntimeActionResultHookPayload | RunEvent>({
    token: privateContext.replyToken,
  });
  try {
    await claimHookOwnership(child);
  } catch (error) {
    throw new SubagentRelayError(error, false);
  }
  try {
    try {
      for await (const payload of child) {
        if (payload.kind === "runtime-action-result") {
          const result = payload.results.find(
            (candidate): candidate is Extract<typeof candidate, { kind: "subagent-result" }> =>
              candidate.kind === "subagent-result" &&
              candidate.callId === ctx.callId &&
              candidate.subagentName === privateContext.subagentName,
          );
          if (result !== undefined) return result;
          continue;
        }
        if (isRunEvent(payload)) {
          await resumeHook(ctx.owner.report, {
            event: payload,
            from: readRunRef(ctx),
            kind: "subagent-event",
          });
        }
      }
    } catch (error) {
      if (error instanceof SubagentRelayError) throw error;
      throw new SubagentRelayError(error, true);
    }
  } finally {
    try {
      await disposeHook(child);
    } catch {
      // The child result or failure is authoritative; teardown cannot replace
      // it with dispatch provenance after this relay adopted the child hook.
    }
  }

  throw new SubagentRelayError(
    new Error(`Subagent "${ctx.toolName}" closed without a result.`),
    true,
  );
}

export class SubagentRelayError extends Error {
  readonly childAdopted: boolean;
  readonly relayCause: unknown;

  constructor(relayCause: unknown, childAdopted: boolean) {
    super(relayCause instanceof Error ? relayCause.message : String(relayCause));
    this.childAdopted = childAdopted;
    this.relayCause = relayCause;
  }
}

function readPrivateContext(ctx: ToolContext): {
  readonly replyToken: string;
  readonly subagentName: string;
} {
  const value = Reflect.get(ctx, Symbol.for("eve.subagent-tool-run"));
  if (typeof value !== "object" || value === null) {
    throw new Error(`Subagent "${ctx.toolName}" has no private execution context.`);
  }
  const replyToken = Reflect.get(value, "replyToken");
  if (typeof replyToken !== "string" || replyToken.length === 0) {
    throw new Error(`Subagent "${ctx.toolName}" has no child reply hook.`);
  }
  const subagentName = Reflect.get(value, "subagentName");
  if (typeof subagentName !== "string" || subagentName.length === 0) {
    throw new Error(`Subagent "${ctx.toolName}" has no private subagent name.`);
  }
  return { replyToken, subagentName };
}
