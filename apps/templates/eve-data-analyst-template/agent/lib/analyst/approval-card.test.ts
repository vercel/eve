import { renderInteractionBlocks } from "eve/channels/slack";
import type {
  SlackInteractionCard,
  SlackInteractionCardParts,
} from "eve/channels/slack";
import { emptySessionView } from "eve/events";
import type { Interaction } from "eve/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { JsonValue } from "../json";
import { stateProvider } from "../state";
import { installTestState, testState } from "../testing/state";
import { isObject } from "../values";
import { recordQueryEstimate, runSqlApprovalCard } from "./approval-card";

type Overrides = Partial<Omit<Interaction, "call" | "request">> & {
  input?: Record<string, string>;
  kind?: Interaction["request"]["kind"];
  toolName?: string;
};

/* A run_sql approval as eve's session view reports it. */
const approval = ({
  input = { purpose: "MRR by plan", sql: "SELECT 1" },
  kind = "approval",
  toolName = "run_sql",
  ...interaction
}: Overrides = {}): Interaction => ({
  call: { callId: "call-1", input, name: toolName },
  interactionId: "interaction-1",
  request: {
    kind,
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "deny", label: "Deny" },
    ],
    prompt: "Approve run_sql?",
  },
  status: "open",
  stepIndex: 0,
  turnId: "turn-1",
  ...interaction,
});

const cardFor = (
  interaction: Interaction,
  answeredBy?: string
): SlackInteractionCard => ({
  audience: "private",
  destination: "thread",
  interaction,
  view: emptySessionView(),
  ...(answeredBy && { answeredBy }),
});

/*
 * Stands in for eve's default card: its own blocks for an open, unanswered
 * request, rendered by eve's public `renderInteractionBlocks`, and one block
 * without controls once the request is answered or ended.
 */
const eveDefault = ({
  interaction,
}: SlackInteractionCard): SlackInteractionCardParts =>
  interaction.status === "open" && interaction.answer === undefined
    ? {
        controls: {
          blocks: renderInteractionBlocks(interaction),
          text: interaction.request.prompt,
        },
      }
    : {
        controls: {
          blocks: [
            { text: { text: "Answered", type: "mrkdwn" }, type: "section" },
          ],
          text: "Answered",
        },
      };

const buttonSchema = z.object({
  action_id: z.string(),
  style: z.string().optional(),
  text: z.object({ text: z.string() }),
  type: z.literal("button"),
  value: z.string(),
});

/* Every button in a rendered card, wherever eve or the card nests it. */
const buttonsIn = (value: JsonValue): z.infer<typeof buttonSchema>[] => {
  if (Array.isArray(value)) {
    return value.flatMap(buttonsIn);
  }
  if (!isObject(value)) {
    return [];
  }
  const own = buttonSchema.safeParse(value);
  return [
    ...(own.success ? [own.data] : []),
    ...Object.values(value).flatMap(buttonsIn),
  ];
};

/* The identity eve compares when it checks a card: action ID and value, sorted. */
const controlIds = (buttons: readonly z.infer<typeof buttonSchema>[]) =>
  buttons.map((button) => `${button.action_id}=${button.value}`).toSorted();

/* The buttons of a card's controls message. */
const buttonsOf = ({ controls }: SlackInteractionCardParts) =>
  buttonsIn(z.array(z.json()).parse(controls.blocks));

const render = (interaction: Interaction, answeredBy?: string) => {
  const { interactionCard } = runSqlApprovalCard;
  if (!interactionCard) {
    throw new Error("Expected an interactionCard renderer.");
  }
  const next = vi.fn(eveDefault);
  const parts = interactionCard(cardFor(interaction, answeredBy), next);
  return {
    buttons: buttonsOf(parts),
    json: JSON.stringify(parts.controls.blocks),
    next,
    parts,
  };
};

beforeEach(() => {
  installTestState();
  testState.reset();
});

describe("runSqlApprovalCard", () => {
  it.each([
    ["other tools' approvals", approval({ toolName: "post_slack_table" })],
    ["questions", approval({ kind: "question" })],
    ["budget prompts", approval({ kind: "budget" })],
  ])("keeps eve's default card for %s", (_name, interaction) => {
    const { next, parts } = render(interaction);
    expect(parts).toStrictEqual(next.mock.results[0]?.value);
  });

  it("shows the estimate, SQL, and who may answer", () => {
    recordQueryEstimate("call-1", {
      askerSlackUserId: "U123",
      planRows: 3_100_000,
      sql: "SELECT 1",
      threshold: 1_000_000,
      totalCost: 2_400_000,
    });
    const card = render(approval());
    expect(card.json).toContain("Approve query: MRR by plan");
    expect(card.json).toContain(
      "Estimated cost 2.4M (approval needed above 1M) · about 3.1M rows"
    );
    expect(card.json).toContain("SELECT 1");
    expect(card.json).toContain("Only <@U123> can run or cancel this query.");
    expect(card.parts.controls.blocks.length).toBeLessThanOrEqual(50);
    expect(card.parts.details).toBeUndefined();
  });

  it("keeps exactly eve's controls and only relabels them", () => {
    const interaction = approval();
    const card = render(interaction);
    const defaults = buttonsOf(eveDefault(cardFor(interaction)));
    // eve refuses a card whose controls differ from its own by action ID or value.
    expect(controlIds(card.buttons)).toStrictEqual(controlIds(defaults));
    expect(defaults).toHaveLength(2);
    const labels = Object.fromEntries(
      card.buttons.map((button) => [button.value, button.text.text])
    );
    expect(labels).toStrictEqual({ approve: "Run query", deny: "Cancel" });
    expect(
      card.buttons.find((button) => button.value === "approve")?.style
    ).toBe("primary");
  });

  it("keeps eve's default for an open request whose controls aren't buttons", () => {
    const { interactionCard } = runSqlApprovalCard;
    const select = {
      controls: {
        blocks: [
          {
            elements: [
              { action_id: "eve_input:interaction-1", type: "static_select" },
            ],
            type: "actions",
          },
        ],
        text: "Approve run_sql?",
      },
    };
    const none = { controls: { blocks: [], text: "Approve run_sql?" } };
    expect(interactionCard?.(cardFor(approval()), () => select)).toBe(select);
    // Without eve's buttons nobody could answer, so the card never claims the request ended.
    expect(interactionCard?.(cardFor(approval()), () => none)).toBe(none);
  });

  it("never shows an estimate recorded for different SQL", () => {
    recordQueryEstimate("call-1", {
      askerSlackUserId: "U123",
      planRows: 1,
      sql: "SELECT 2",
      threshold: 1,
      totalCost: 2,
    });
    const card = render(approval());
    expect(card.json).toContain("estimated cost needs approval");
    expect(card.json).toContain("Only the person who asked");
  });

  it("falls back to the generic cost line when state can't be read", () => {
    recordQueryEstimate("call-1", {
      askerSlackUserId: "U123",
      planRows: 1,
      sql: "SELECT 1",
      threshold: 1,
      totalCost: 2,
    });
    // eve can render a card outside a session step, such as for a click on an ended session.
    vi.spyOn(stateProvider, "create").mockImplementation(() => {
      throw new Error("No active session.");
    });
    const card = render(approval());
    expect(card.json).toContain("estimated cost needs approval");
    expect(card.buttons).toHaveLength(2);
  });

  it("truncates long SQL and escapes the fallback text", () => {
    const sql = `SELECT '<b>' AS x, ${"1 + ".repeat(1000)}1`;
    const card = render(approval({ input: { purpose: "Big", sql } }));
    expect(card.json).toContain("… [truncated]");
    expect(card.parts.controls.text).not.toMatch(/[<>]/u);
    expect(card.parts.controls.text).toContain("&lt;b&gt;");
  });

  it("escapes SQL operators as Slack entities in the fallback text", () => {
    const sql = "SELECT 1 WHERE a >= 1 AND tags @> '{x}' AND q = 'A&B'";
    const { text } = render(approval({ input: { purpose: "Ops", sql } })).parts
      .controls;
    expect(text).toContain("&gt;=");
    expect(text).toContain("@&gt;");
    expect(text).toContain("A&amp;B");
    expect(text).not.toMatch(/[‹›]/u);
  });

  it("uses a generic title when the input has no purpose or SQL", () => {
    const card = render(approval({ input: {} }));
    expect(card.json).toContain("Approve query: Run a query");
    expect(card.buttons).toHaveLength(2);
  });

  it.each([
    [
      "an approval",
      { answer: { interactionId: "interaction-1", optionId: "approve" } },
      "Approved by <@U123>",
    ],
    [
      "a denial",
      { answer: { interactionId: "interaction-1", optionId: "deny" } },
      "Cancelled by <@U123>",
    ],
    [
      "an approval settled without a recorded answer",
      { outcome: "accepted" as const, status: "settled" as const },
      "Approved by <@U123>",
    ],
    [
      "a denial settled without a recorded answer",
      { outcome: "declined" as const, status: "settled" as const },
      "Cancelled by <@U123>",
    ],
  ])("replaces the buttons after %s", (_name, state, line) => {
    const card = render(approval(state), "U123");
    expect(card.buttons).toStrictEqual([]);
    expect(card.json).toContain(line);
    expect(card.json).toContain("Approve query: MRR by plan");
    expect(card.json).toContain("SELECT 1");
    expect(card.json).not.toContain("can run or cancel this query");
  });

  it("keeps the estimate on an answered card, and says nothing about cost without one", () => {
    const answered = {
      answer: { interactionId: "interaction-1", optionId: "approve" },
    };
    expect(render(approval(answered)).json).not.toContain("cost");
    recordQueryEstimate("call-1", {
      askerSlackUserId: "U123",
      planRows: 3_100_000,
      sql: "SELECT 1",
      threshold: 1_000_000,
      totalCost: 2_400_000,
    });
    expect(render(approval(answered)).json).toContain("Estimated cost 2.4M");
  });

  it("removes controls when a request expires without an answer", () => {
    const card = render(approval({ outcome: "expired", status: "settled" }));
    expect(card.buttons).toStrictEqual([]);
    expect(card.json).toContain('"text":"No longer needed"');
    expect(card.parts.controls.text).toBe(
      "Approve query: MRR by plan\nNo longer needed"
    );
  });

  it("keeps only the newest 50 estimates", () => {
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
    const forCall = (callId: string): Interaction => ({
      ...approval(),
      call: { callId, input: { purpose: "MRR", sql }, name: "run_sql" },
    });
    expect(render(forCall("call-50")).json).toContain("Estimated cost");
    expect(render(forCall("call-0")).json).toContain(
      "estimated cost needs approval"
    );
  });
});
