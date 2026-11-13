import type { ToolStubHost } from "#execution/tool-stub-host.js";
import { StubPlayback } from "#tool-stubs/playback.js";

/**
 * Tool stubs on the in-process host. A stubbed root session holds its playback for as long as
 * it runs, by its scope's token, and its calls (and its child sessions' and runs', whose scope
 * names the same token) read it directly. Workflow's serves the same playback on a hook, and
 * publishes results and failures to streams eval verification reads; an in-process session has
 * no such reader, so this keeps only the playback.
 */
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
