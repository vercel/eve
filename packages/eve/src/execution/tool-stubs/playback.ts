import { createHook } from "#compiled/@workflow/core/index.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import { StubPlayback } from "#tool-stubs/playback.js";
import {
  failStubSessionStep,
  publishStubFailureStep,
  publishStubResultStep,
} from "#execution/tool-stubs/steps.js";
import type { StubCall, StubScope } from "#tool-stubs/types.js";

export type StubRequest =
  | { readonly kind: "call"; readonly call: StubCall }
  | { readonly kind: "failure"; readonly callId: string; readonly error: string };

export async function withStubPlayback<T>(
  scope: StubScope | undefined,
  sessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  if (scope === undefined || scope.rootSessionId !== undefined) return await run();
  let playback: StubPlayback;
  try {
    playback = new StubPlayback(scope.rules);
  } catch (error) {
    await publishStubFailureStep(
      error instanceof Error ? error.message : "Could not create tool stub validators.",
    );
    throw error;
  }
  const hook = createHook<StubRequest>({ token: scope.token });
  let failed = false;
  const serve = async (): Promise<never> => {
    for await (const request of hook) {
      const matchedBefore = playback.matchedRuleCount;
      const result =
        request.kind === "failure"
          ? playback.fail(request.callId, request.error)
          : playback.call(request.call);
      if (result.kind === "error" && !failed) {
        await publishStubFailureStep(result.error);
        failed = true;
      }
      await publishStubResultStep({
        callId: request.kind === "call" ? request.call.callId : `${request.callId}:failure`,
        result,
        matchedRuleId:
          result.kind === "stub" && playback.matchedRuleCount > matchedBefore
            ? result.ruleId
            : undefined,
      });
    }
    throw new Error("Tool stub playback ended before its session.");
  };
  try {
    await claimHookOwnership(hook);
    const running = run();
    const serving = serve().catch(async () => {
      await publishStubFailureStep("Tool stub playback failed.");
      await failStubSessionStep(sessionId);
      return await running;
    });
    return await Promise.race([running, serving]);
  } finally {
    await disposeHook(hook);
  }
}
