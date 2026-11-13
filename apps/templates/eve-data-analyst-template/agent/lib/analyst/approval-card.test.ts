import { beforeEach, describe, expect, it } from "vitest";

import type { SlackInputRequest } from "../integrations/slack/input-requests";
import { installTestState, testState } from "../testing/state";
import { recordQueryEstimate, runSqlApprovalCard } from "./approval-card";

const approval = (
  input?: Record<string, string>,
  toolName = "run_sql"
): SlackInputRequest => ({
  action: {
    callId: "call-1",
    input: input ?? { purpose: "MRR by plan", sql: "SELECT 1" },
    kind: "tool-call",
    toolName,
  },
  kind: "tool-approval",
  options: [
    { id: "approve", label: "Approve", style: "primary" },
    { id: "cancel", label: "Cancel" },
  ],
  prompt: "Approve run_sql?",
  requestId: "request-1",
});

const render = async (request: SlackInputRequest) => {
  const presentation = await runSqlApprovalCard.render?.(request);
  if (!presentation) {
    throw new Error("Expected the run_sql card.");
  }
  return { ...presentation, json: JSON.stringify(presentation.blocks) };
};

beforeEach(() => {
  installTestState();
  testState.reset();
});

describe("runSqlApprovalCard", () => {
  it("ignores other tools and questions", async () => {
    expect(
      await runSqlApprovalCard.render?.(approval({}, "post_slack_table"))
    ).toBeUndefined();
    expect(
      await runSqlApprovalCard.render?.({ ...approval(), kind: "question" })
    ).toBeUndefined();
  });

  it("shows the estimate, SQL, eve-compatible buttons, and who may answer", async () => {
    recordQueryEstimate("call-1", {
      askerSlackUserId: "U123",
      planRows: 3_100_000,
      sql: "SELECT 1",
      threshold: 1_000_000,
      totalCost: 2_400_000,
    });
    const card = await render(approval());
    expect(card.json).toContain("Approve query: MRR by plan");
    expect(card.json).toContain(
      "Estimated cost 2.4M (approval needed above 1M) · about 3.1M rows"
    );
    expect(card.json).toContain("SELECT 1");
    expect(card.json).toContain("Only <@U123> can run or cancel this query.");
    expect(card.json).toContain(
      '"action_id":"eve_input:tool-approval:request-1:button:0"'
    );
    expect(card.json).toContain('"text":"Run query"');
    expect(card.json).toContain('"text":"Cancel"');
    expect(card.blocks.length).toBeLessThanOrEqual(50);
  });

  it("never shows an estimate recorded for different SQL", async () => {
    recordQueryEstimate("call-1", {
      askerSlackUserId: "U123",
      planRows: 1,
      sql: "SELECT 2",
      threshold: 1,
      totalCost: 2,
    });
    const card = await render(approval());
    expect(card.json).toContain("estimated cost needs approval");
    expect(card.json).toContain("Only the person who asked");
  });

  it("truncates long SQL and escapes the fallback text", async () => {
    const sql = `SELECT '<b>' AS x, ${"1 + ".repeat(1000)}1`;
    const card = await render(approval({ purpose: "Big", sql }));
    expect(card.json).toContain("… [truncated]");
    expect(card.text).not.toMatch(/[<>]/u);
    expect(card.text).toContain("&lt;b&gt;");
  });

  it("escapes SQL operators as Slack entities in the fallback text", async () => {
    const sql = "SELECT 1 WHERE a >= 1 AND tags @> '{x}' AND q = 'A&B'";
    const card = await render(approval({ purpose: "Ops", sql }));
    expect(card.text).toContain("&gt;=");
    expect(card.text).toContain("@&gt;");
    expect(card.text).toContain("A&amp;B");
    expect(card.text).not.toMatch(/[‹›]/u);
  });

  it("keeps only the newest 50 estimates", async () => {
    const sql = "SELECT 1";
    for (let index = 0; index <= 50; index += 1) {
      recordQueryEstimate(`call-${index}`, {
        askerSlackUserId: null,
        planRows: 1,
        sql,
        threshold: 1,
        totalCost: 2,
      });
    }
    const forCall = (callId: string) => {
      const request = approval({ purpose: "MRR", sql });
      if (request.kind !== "tool-approval") {
        throw new Error("Expected a tool approval.");
      }
      return { ...request, action: { ...request.action, callId } };
    };
    const newest = await render(forCall("call-50"));
    const oldest = await render(forCall("call-0"));
    expect(newest.json).toContain("Estimated cost");
    expect(oldest.json).toContain("estimated cost needs approval");
  });
});
