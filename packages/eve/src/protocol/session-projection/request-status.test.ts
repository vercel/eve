import { describe, expect, it } from "vitest";

import type { StoredLine } from "#protocol/session-events/envelope.js";
import { emptySessionView, foldLines } from "#protocol/session-projection/fold.js";
import { requestStatus } from "#protocol/session-projection/request-status.js";

const at = "2026-10-10T00:00:00.000Z";

function statusAfter(...lines: (readonly object[])[]) {
  const view = emptySessionView();
  foldLines(
    view,
    lines.map((facts) => ({ at, facts: [...facts] }) as StoredLine),
    0,
  );
  return requestStatus(view, "d_0");
}

const admitted = [
  { data: {}, type: "session.started" },
  { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
];

describe("a request's status", () => {
  it("reads an outcome a newer writer adds as failed", () => {
    expect(
      statusAfter(admitted, [
        { data: { deliveryId: "d_0", outcome: "handed-off" }, type: "delivery.settled" },
      ]),
    ).toBe("failed");
  });
});
