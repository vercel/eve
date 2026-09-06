import { expect, it } from "vitest";
import { v5ToV6 } from "./v5-to-v6.js";

it("preserves ordinary cancellation for an old parent", () => {
  expect(v5ToV6.down({ kind: "cancel", version: 6, turnId: "turn-1", tasks: false })).toEqual({
    kind: "cancel",
    version: 5,
    turnId: "turn-1",
  });
});

it("rejects task cancellation instead of silently changing what gets cancelled", () => {
  expect(() => v5ToV6.down({ kind: "cancel", version: 6, tasks: true })).toThrow(
    "session-owned task cancellation",
  );
});
