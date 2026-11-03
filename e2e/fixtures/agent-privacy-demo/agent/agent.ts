import { e2eAgentConfig } from "@eve-e2e/config";
import { outputOf, playScript } from "@eve-e2e/config/mock-script";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";
import { privateContext, strictest } from "eve/extensions/private-context";
import { taintPolicy } from "eve/extensions/taint";

const SCENARIOS: Record<string, (request: MockModelRequest) => MockModelResponse | string> = {
  /** Reads Alice's notes and DMs, then posts a summary to #general. */
  "PRIVACY-SUMMARY": (request) =>
    playScript(
      request,
      [
        { id: "notes", input: () => ({ query: "this week" }), name: "notion_search" },
        { id: "dms", input: () => ({ query: "this week" }), name: "slack_search_dms" },
        {
          id: "post",
          input: () => ({ channel: "#general", text: "Alice's week, summarized." }),
          name: "post_to_slack",
        },
      ],
      (done) => `POST-RESULT ${outputOf(done, "post")}`,
    ),
  /** Reads a public issue and Alice's notes, then does what the issue asks. */
  "PRIVACY-ISSUE": (request) =>
    playScript(
      request,
      [
        { id: "issue", input: () => ({ number: 42 }), name: "read_public_issue" },
        { id: "notes", input: () => ({ query: "login bug" }), name: "notion_search" },
        { id: "export", input: () => ({ records: "customers" }), name: "export_csv" },
      ],
      (done) => `EXPORT-RESULT ${outputOf(done, "export")}`,
    ),
  /** Reads a public issue, then posts about it: untrusted content with no sensitive data. */
  "PRIVACY-TRIAGE": (request) =>
    playScript(
      request,
      [
        { id: "issue", input: () => ({ number: 42 }), name: "read_public_issue" },
        {
          id: "post",
          input: () => ({ channel: "#triage", text: "Issue 42: login fails on Safari." }),
          name: "post_to_slack",
        },
      ],
      (done) => `POST-RESULT ${outputOf(done, "post")}`,
    ),
  /** Reads Alice's notes. */
  "PRIVACY-NOTES": (request) =>
    playScript(
      request,
      [{ id: "notes", input: () => ({ query: "this week" }), name: "notion_search" }],
      (done) => `NOTES-RESULT ${outputOf(done, "notes")}`,
    ),
};

function respond(request: MockModelRequest): MockModelResponse | string {
  const directive = (request.lastUserMessage ?? "").trim().split(/\s+/u)[0] ?? "";
  return SCENARIOS[directive]?.(request) ?? `Mock reply: ${request.lastUserMessage ?? ""}`;
}

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
  approval: strictest(taintPolicy(), privateContext()),
});
