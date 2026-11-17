import type { ToolStubHost } from "#execution/tool-stub-host.js";
import { StubPlayback } from "#tool-stubs/playback.js";

export function createInProcessToolStubs(): ToolStubHost {
  const playbacks = new Map<string, StubPlayback>();
  const playbackOf = (token: string): StubPlayback => {
    const playback = playbacks.get(token);
    if (playback === undefined) throw new Error("Tool stub playback ended before its session.");
    return playback;
  };
  return {
    async serve(scope, _sessionId, run) {
      playbacks.set(scope.token, new StubPlayback(scope.rules));
      try {
        return await run();
      } finally {
        playbacks.delete(scope.token);
      }
    },
    call: async (scope, call) => playbackOf(scope.token).call(call),
    async fail(scope, callId, error) {
      playbackOf(scope.token).fail(callId, error);
    },
  };
}
