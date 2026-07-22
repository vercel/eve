import { describe, expect, it } from "vitest";

import { readLoopKind, readLoopTemporalDevServer } from "#internal/loops/config.js";

describe("loops config", () => {
  it("leaves the production Workflow runtime unchanged when no override exists", () => {
    expect(readLoopKind({})).toBe("workflow");
  });

  it.each(["inline", "workflow", "temporal"] as const)("accepts the %s runtime", (runtime) => {
    expect(readLoopKind({ EVE_LOOP: runtime })).toBe(runtime);
  });

  it("rejects unknown runtime names at the environment boundary", () => {
    expect(() => readLoopKind({ EVE_LOOP: "threads" })).toThrow(
      'EVE_LOOP must be "inline", "workflow", or "temporal"',
    );
  });

  it("reads optional Temporal dev-server observability settings", () => {
    expect(
      readLoopTemporalDevServer({
        EVE_LOOP_TEMPORAL_DB: " /tmp/temporal.sqlite ",
        EVE_LOOP_TEMPORAL_UI_PORT: " 8233 ",
      }),
    ).toEqual({ dbFilename: "/tmp/temporal.sqlite", uiPort: 8233 });
    expect(readLoopTemporalDevServer({})).toEqual({});
    expect(readLoopTemporalDevServer({ EVE_LOOP_TEMPORAL_DB: "  " })).toEqual({});
  });

  it("rejects a malformed Temporal UI port", () => {
    expect(() => readLoopTemporalDevServer({ EVE_LOOP_TEMPORAL_UI_PORT: "portal" })).toThrow(
      'must be a port number; received "portal"',
    );
  });
});
