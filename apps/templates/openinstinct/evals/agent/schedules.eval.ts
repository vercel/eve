import { defineEval } from "eve/evals";
import { isDeepStrictEqual } from "node:util";
import {
  agentEvalTags,
  assertPlainTextDelivery,
  requireDeliveredText,
} from "@evals/agent/shared";

const cases = [
  {
    description: "Creates a one-time reminder at an exact instant",
    expected: {
      missedRunPolicy: "run_latest",
      prompt: "Renew the library card.",
      timing: { at: "2099-01-15T15:00:00Z", kind: "once" },
    },
    prompt:
      "Create a one-time reminder for January 15, 2099 at 3:00 PM UTC. Use exactly 'Renew the library card.' as the reminder text.",
  },
  {
    description: "Creates a timezone-aware weekday reminder",
    expected: {
      missedRunPolicy: "run_latest",
      prompt: "Review my priorities.",
      timing: {
        frequency: "weekdays",
        kind: "calendar",
        localTime: "08:15",
        timezone: "America/New_York",
      },
    },
    prompt:
      "Create a recurring reminder every weekday at 8:15 AM America/New_York. Use exactly 'Review my priorities.' as the reminder text.",
  },
] as const;

export default cases.map((testCase) =>
  defineEval({
    description: testCase.description,
    tags: [...agentEvalTags, "schedules"],
    async test(t) {
      const turn = await t.send(testCase.prompt);
      turn.expectOk();
      turn.succeeded();
      turn.calledTool("schedules-create", {
        input: (input) => isDeepStrictEqual(input, testCase.expected),
        status: "completed",
        count: 1,
      });
      turn.notEvent("child.opened", { data: { name: "browser-agent" } });
      const text = await requireDeliveredText(t, turn);
      assertPlainTextDelivery(t, text);
    },
  })
);
