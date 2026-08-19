import type { ProgressSnapshotV1 } from "#execution/session-progress.js";

export interface SessionProgressRenderState {
  readonly renderCount: number;
  readonly snapshot: ProgressSnapshotV1;
}

/** Test-only presentation boundary used to prove driver-owned progress state. */
export async function renderSessionProgressStep(input: {
  readonly previousRenderCount: number;
  readonly snapshot: ProgressSnapshotV1;
}): Promise<SessionProgressRenderState> {
  "use step";
  return { renderCount: input.previousRenderCount + 1, snapshot: input.snapshot };
}
