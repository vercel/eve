import { e2eAgentConfig } from "@eve-e2e/config";
import { outputOf, playScript, type ScriptedCall } from "@eve-e2e/config/mock-script";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";
import { exceedsCap, privateContext, strictest } from "eve/extensions/private-context";
import { untrustedContentPolicy } from "eve/extensions/untrusted-content";

const call = (id: string, name: string, input: object): ScriptedCall => ({
  id,
  input: () => input,
  name,
});

const notes = call("notes", "notion_search", { query: "this week" });
const wiki = call("wiki", "wiki_search", { query: "Q3 plan" });
const issue = call("issue", "read_public_issue", { number: 42 });
const post = (text: string) => call("post", "post_to_slack", { channel: "#general", text });

/** Each scenario's calls, in order; the reply reports the last call's result. */
const SCENARIOS: Record<string, readonly ScriptedCall[]> = {
  /** Personal data to a workspace channel: private-context asks. */
  "PRIVACY-SUMMARY": [
    notes,
    call("dms", "slack_search_dms", { query: "this week" }),
    post("Alice's week, summarized."),
  ],
  /** Personal data back to its owner: runs. */
  "PRIVACY-OWNER-DM": [notes, call("dm", "send_slack_dm", { text: "Your week, summarized." })],
  /** Sensitive data to a workspace channel, with nothing untrusted read: runs. */
  "PRIVACY-INTERNAL-POST": [wiki, post("Q3 plan: launch moves to Friday.")],
  /** Untrusted content, then a post with no confidential data: two legs, runs. */
  "PRIVACY-TRIAGE": [issue, post("Issue 42: login fails on Safari.")],
  /** Untrusted content and sensitive data, then a public export: all three legs, denied. */
  "PRIVACY-ISSUE": [issue, wiki, call("export", "export_csv", { records: "customers" })],
  /** A personal read, in whatever conversation the session is in. */
  "PRIVACY-NOTES": [notes],
};

function respond(request: MockModelRequest): MockModelResponse | string {
  const directive = (request.lastUserMessage ?? "").trim().split(/\s+/u)[0] ?? "";
  const calls = SCENARIOS[directive];
  if (calls === undefined) return `Mock reply: ${request.lastUserMessage ?? ""}`;
  const last = calls.at(-1)!;
  return playScript(request, calls, (done) => `RESULT ${outputOf(done, last.id)}`);
}

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
  // The Rule of Two for untrusted content, and private-context for personal data on its own.
  approval: strictest(
    untrustedContentPolicy({ when: exceedsCap }),
    privateContext({ sensitiveFlows: "allow" }),
  ),
});
