import type { EveToolPart } from "eve/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMessagePart } from "./parts";

function renderCall(part: EveToolPart) {
  return renderToStaticMarkup(
    <AgentMessagePart
      canRespond={false}
      onAnswers={() => undefined}
      part={part}
      showCaret={false}
      userVisibleOnly={false}
    />
  );
}
const call = {
  type: "tool",
  kind: "tool",
  callId: "browser-call",
  stepIndex: 0,
  name: "run_browser",
  label: "Browser task",
  input: { message: "Read a public page" },
} as const;
describe("tool outcomes", () => {
  it("distinguishes cancellation from failure and explains it without an exception payload", () => {
    const markup = renderCall({ ...call, state: "cancelled" });
    expect(markup).toContain("Cancelled");
    expect(markup).toContain("Cancelled before completion.");
    expect(markup).not.toContain(">Error<");
  });
  it("opens failed calls with their recorded error", () => {
    const markup = renderCall({
      ...call,
      state: "failed",
      error: { code: "BROWSER_FAILURE", message: "Kernel unavailable" },
    });
    expect(markup).toContain("Kernel unavailable");
  });
  it("explains a failed call even when no error details were recorded", () => {
    expect(renderCall({ ...call, state: "failed" })).toContain(
      "The tool call failed without error details."
    );
  });
});
