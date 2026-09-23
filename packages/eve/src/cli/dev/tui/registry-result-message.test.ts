import { describe, expect, it } from "vitest";

import { registryCommandOutcome } from "./registry-result-message.js";

describe("registryCommandOutcome", () => {
  it("leaves a plain installation to its summary", () => {
    expect(
      registryCommandOutcome({
        outcomes: [{ kind: "installed", title: "connection/notion", facts: [], output: [] }],
      }),
    ).toEqual({ status: "success", summary: "Added connection/notion", message: "" });
  });

  it("hangs one installation's facts under its summary", () => {
    expect(
      registryCommandOutcome({
        outcomes: [
          {
            kind: "installed",
            title: "channel/photon",
            facts: [
              { label: "Agent phone number", value: "+15551234567", kind: "phone" },
              { label: "Mode", value: "dev" },
            ],
            output: ["Configured MCP connection."],
          },
        ],
      }),
    ).toEqual({
      status: "success",
      summary: "Added channel/photon",
      message:
        "Agent phone number  +15551234567\nMode                dev\nConfigured MCP connection.",
    });
  });

  it("marks unfinished setup as neutral with a resume command and flow warnings", () => {
    expect(
      registryCommandOutcome(
        {
          outcomes: [
            {
              kind: "incomplete",
              title: "channel/slack",
              resumeCommand: "eve add channel/slack --skip-install",
            },
          ],
        },
        ["Wait for the Slack request to expire before retrying."],
      ),
    ).toEqual({
      status: "neutral",
      summary: "Added channel/slack · setup not finished",
      message:
        "Finish with `eve add channel/slack --skip-install`\n" +
        "⚠ Wait for the Slack request to expire before retrying.",
    });
  });

  it("reports a cancellation before installation without detail", () => {
    expect(
      registryCommandOutcome({ outcomes: [{ kind: "cancelled", title: "connection/sentry" }] }),
    ).toEqual({ status: "neutral", summary: "connection/sentry not added", message: "" });
  });

  it("splits a failure's retry hint onto its own line", () => {
    expect(
      registryCommandOutcome({
        outcomes: [
          {
            kind: "failed",
            title: "channel/slack",
            message:
              "Vercel CLI is not authenticated. Try again with `eve add channel/slack --skip-install`.",
          },
        ],
      }),
    ).toEqual({
      status: "error",
      summary: "Couldn't add channel/slack",
      message:
        "Vercel CLI is not authenticated.\nTry again with `eve add channel/slack --skip-install`.",
    });
  });

  it("lists one marked row per item when several settle", () => {
    expect(
      registryCommandOutcome({
        outcomes: [
          { kind: "installed", title: "Web Chat", facts: [], output: [] },
          { kind: "cancelled", title: "Slack" },
          { kind: "failed", title: "GitHub", message: "Installation failed." },
        ],
      }),
    ).toEqual({
      status: "error",
      summary: "Added 1 of 3 items",
      message: "✓ Web Chat\n– Slack\n⨯ GitHub\n  Installation failed.",
    });
  });
});
