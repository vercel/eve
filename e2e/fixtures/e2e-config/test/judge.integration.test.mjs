import assert from "node:assert/strict";
import { test } from "node:test";

import { e2eJudgeModel } from "../src/judge.ts";

test("fixture judge adapts Gateway Responses into evaluation answers", async (t) => {
  const previousKey = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "fixture-gateway-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousKey;
  });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return Response.json({
      id: "fixture-response",
      model: "openai/gpt-5.6-luna",
      output: [
        {
          type: "message",
          id: "fixture-message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({ q0: 0.9, q1: 1.5, q2: "c0" }),
              annotations: [],
            },
          ],
        },
      ],
    });
  });

  const result = await e2eJudgeModel().doEvaluate({
    state: { response: "Hello Alice" },
    questions: {
      accurate: { type: "boolean", instructions: "Greets Alice" },
      clarity: {
        type: "score",
        instructions: "Grade clarity",
        criteria: ["Unclear", "Mostly clear", "Clear"],
      },
      outcome: {
        type: "choice",
        instructions: "Classify the response",
        criteria: { answered: "Answers", declined: "Declines" },
      },
    },
  });

  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.equal(String(url), "https://ai-gateway.vercel.sh/v1/responses");
  assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-gateway-key");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "openai/gpt-5.6-luna");
  assert.equal(body.text.format.type, "json_schema");
  assert.deepEqual(result.answers, {
    accurate: { type: "boolean", probability: 0.9 },
    clarity: { type: "score", score: 1.5 },
    outcome: { type: "choice", choice: "answered" },
  });
});
