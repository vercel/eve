import { describe, expect, it } from "vitest";
import {
  type AgentFeedbackReport,
  decodeReportHash,
  encodeReportHash,
  formatReport,
  includeEverything,
  reviewReport,
} from "./report";

const report: AgentFeedbackReport = {
  schemaVersion: 1,
  title: "Slack channel drops thread replies after redeploy",
  triggerReason: "unexpected-behavior",
  setup: {
    deployTarget: "vercel",
    relevantFeatures: ["schedules"],
  },
  steps: ["Deploy an agent with a Slack channel", "Reply in an existing thread after redeploy"],
  observed: ["The reply is never delivered", "No error is logged"],
  expected: "The agent replies in the thread.",
  comparison: "New threads work.",
  frequency: "reproduced",
  outcome: "worked-around",
  eveVersion: "0.12.3",
  agent: "Claude Code",
};

describe("report hash", () => {
  it("round-trips a report, including non-ASCII text", () => {
    const withUnicode = { ...report, expected: "Réponse dans le fil ✅" };
    expect(decodeReportHash(encodeReportHash(withUnicode))).toEqual(withUnicode);
  });

  it("rejects missing, malformed, and invalid reports", () => {
    expect(decodeReportHash("")).toBeUndefined();
    expect(decodeReportHash("#report=not-base64!")).toBeUndefined();
    expect(decodeReportHash(encodeReportHash({ ...report, steps: [] }))).toBeUndefined();
  });

  it("rejects oversized links before decoding", () => {
    expect(decodeReportHash(`#report=${"a".repeat(12_001)}`)).toBeUndefined();
  });
});

describe("reviewReport", () => {
  it("drops removed lines and blank optional fields", () => {
    const reviewed = reviewReport(
      { ...report, setup: { ...report.setup, relevantFeatures: ["  "] } },
      { steps: [true, false], observed: [false, true], comparison: false },
    );

    expect(reviewed).toMatchObject({
      steps: ["Deploy an agent with a Slack channel"],
      observed: ["No error is logged"],
      comparison: undefined,
      setup: { relevantFeatures: undefined },
    });
  });

  it("is invalid once every step is removed", () => {
    expect(
      reviewReport(report, { ...includeEverything(report), steps: [false, false] }),
    ).toBeUndefined();
  });
});

describe("formatReport", () => {
  it("renders eve-specific context in the plain-text report", () => {
    expect(formatReport(report)).toMatchInlineSnapshot(`
      "Slack channel drops thread replies after redeploy

      Setup:
      Trigger: Unexpected behavior
      Deploy target: Vercel
      Relevant features: schedules
      Frequency: Reproduced
      Outcome: Worked around

      How to reproduce:
      1. Deploy an agent with a Slack channel
      2. Reply in an existing thread after redeploy

      Observed:
      - The reply is never delivered
      - No error is logged

      Expected:
      The agent replies in the thread.

      Control or workaround:
      New threads work."
    `);
  });
});
