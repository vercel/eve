import { createHmac } from "node:crypto";

import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const SIGNING_SECRET = "e2e-slack-signing-secret";

export default defineEval({
  description: "Alice corrects a drafted follow-up line and reviews its facts in a Slack modal.",
  async test(t) {
    const submit = (state: unknown) => {
      const body = new URLSearchParams({
        payload: JSON.stringify({
          type: "view_submission",
          team: { id: "T_REVIEW" },
          user: { id: "U_ALICE", team_id: "T_REVIEW" },
          view: {
            id: "V_REVIEW",
            callback_id: "sales_review",
            private_metadata: "draft-123",
            state,
          },
        }),
      }).toString();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")}`;
      return t.target.fetch("/eve/v1/slack", {
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
        },
        method: "POST",
      });
    };

    const empty = await submit({
      values: { draft: { line: { type: "plain_text_input", value: "" } } },
    });
    await t.require(empty.status, equals(200));
    await t.require(
      await empty.json(),
      equals({ response_action: "errors", errors: { draft: "Enter a follow-up line." } }),
    );

    const state = {
      values: {
        draft: {
          line: { type: "plain_text_input", value: "Thanks for walking Bob through the rollout." },
        },
        facts: {
          correct: {
            type: "checkboxes",
            selected_options: [{ value: "company" }, { value: "role" }],
          },
        },
      },
    };
    const reviewed = await submit(state);
    await t.require(reviewed.status, equals(200));
    const response = (await reviewed.json()) as {
      response_action: string;
      view: { blocks: { text: { text: string } }[] };
    };
    await t.require(response.response_action, equals("update"));
    await t.require(
      JSON.parse(response.view.blocks[0]!.text.text),
      equals({
        line: "Thanks for walking Bob through the rollout.",
        reviewId: "draft-123",
        reviewer: "U_ALICE",
        state,
      }),
    );
  },
});
