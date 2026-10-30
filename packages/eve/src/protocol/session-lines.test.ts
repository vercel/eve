import { expect, it } from "vitest";
import { createEventReader } from "./session-lines.js";

it("preserves a progress line's prior commit time when reading from a checkpoint", () => {
  const previousCommitAt = "2024-03-04T05:06:07.000Z";
  const reader = createEventReader(previousCommitAt);
  const [progress] = reader.read(
    {
      progress: {
        type: "content.delta",
        data: { partId: "part_0", delta: "hello" },
      },
    },
    42,
  );
  expect(progress?.meta).toMatchObject({
    at: previousCommitAt,
    position: { line: 42, index: 0 },
  });
  const [commit] = reader.read(
    { at: "2024-03-04T05:06:08.000Z", facts: [{ type: "session.started", data: {} }] },
    43,
  );
  expect(commit?.meta.at).toBe("2024-03-04T05:06:08.000Z");
});
