import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import { snapshotOf } from "#protocol/session-projection/session-view.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import { defaultInteractionEvents } from "#public/channels/slack/defaults.js";
import { answerFromSlackAction } from "#public/channels/slack/hitl.js";
import {
  composeInteractionCards,
  defineSlackRenderer,
  type SlackInteractionCard,
  type SlackInteractionCardParts,
  type SlackRenderer,
} from "#public/channels/slack/renderers.js";
import type {
  SlackApprovalChannelResolver,
  SlackChannelState,
} from "#public/channels/slack/slackChannel.js";

const at = "2026-10-27T00:00:00.000Z";
const turnId = "turn_0";
const runId = "run_0";
const scope = { runId, turnId };

interface Sent {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

interface Asked {
  readonly interactionId: string;
  readonly request: Record<string, unknown>;
  /** The call the request asks about; a budget prompt asks about its turn instead. */
  readonly call?: { readonly name: string; readonly input?: Record<string, string> };
}

/**
 * The Slack channel's input-request handlers over a real session view: `commit` folds facts as
 * the server does and runs each through the handlers, and `sent` records every Slack call.
 */
function harness(
  options: {
    readonly approvalChannel?: SlackApprovalChannelResolver;
    readonly renderers?: readonly SlackRenderer[];
    readonly rejects?: (sent: Sent) => boolean;
  } = {},
) {
  const sent: Sent[] = [];
  let ts = 0;
  const respond = (method: string, body: Record<string, unknown>) => {
    sent.push({ body, method });
    if (options.rejects?.({ body, method })) return { error: "invalid_blocks", ok: false };
    ts += 1;
    return { channel: { id: "D_ALICE" }, ok: true, ts: `ts_${ts}` };
  };
  const state: SlackChannelState = {
    audience: "public",
    channelId: "C1",
    slackUsersByPrincipal: { p_bob: "U_BOB" },
    teamId: null,
    threadTs: "1.0",
    triggeringUserId: "U_ALICE",
  };
  const channel = {
    slack: {
      channelId: "C1",
      request: async (method: string, body: Record<string, unknown>) => respond(method, body),
      threadTs: "1.0",
    },
    state,
    thread: {
      async post(message: string | Record<string, unknown>) {
        const response = respond(
          "thread.post",
          typeof message === "string" ? { text: message } : message,
        );
        if (!response.ok) throw new Error("Slack rejected the message");
        return { id: response.ts };
      },
      async postEphemeral(user: string, text: string) {
        respond("chat.postEphemeral", { text, user });
        return { id: "" };
      },
    },
  };
  const events = defaultInteractionEvents(
    options.approvalChannel,
    composeInteractionCards(options.renderers ?? []),
  );
  const view = emptySessionView();
  let position = 0;

  async function commit(...facts: SessionEvent[]): Promise<void> {
    foldLine(view, { at, facts }, position, { retention: "operational" });
    position += 1;
    const ctx = { channel, session: { auth: {}, id: "s_0" }, view: snapshotOf(view) };
    for (const fact of facts) {
      const handler = events[fact.type as keyof typeof events] as
        | ((event: SessionEvent, ctx: unknown) => Promise<void>)
        | undefined;
      await handler?.(fact, ctx);
    }
  }

  /** Opens `requests` in one commit, as one step asking them together. */
  async function ask(...requests: Asked[]): Promise<void> {
    await commit(
      { data: {}, type: "session.started" },
      { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
    );
    await commit(
      { data: { cause: { deliveryId: "d_0" }, follows: null, turnId }, type: "turn.started" },
      { data: { owner: { turnId }, runId }, scope, type: "model.requested" },
      ...requests.flatMap(({ call, interactionId }): SessionEvent[] =>
        call === undefined
          ? []
          : [
              {
                data: {
                  callId: `call_${interactionId}`,
                  capability: { kind: "tool", name: call.name },
                  input: call.input ?? {},
                  owner: { runId },
                },
                scope,
                type: "call.requested",
              },
            ],
      ),
      { data: { outcome: "completed", runId }, scope, type: "model.settled" },
      ...requests.map(({ call, interactionId, request }): SessionEvent => ({
        data: {
          interactionId,
          request: request as never,
          subject: call === undefined ? { turnId } : { callId: `call_${interactionId}` },
        },
        scope: { turnId },
        type: "interaction.opened",
      })),
    );
  }

  /** Bob's answer to `interactionId`, submitted and admitted. */
  async function answer(interactionId: string, value: Record<string, string>): Promise<void> {
    await commit(
      {
        data: { deliveryId: `d_${interactionId}`, principal: { id: "p_bob", type: "user" } },
        type: "delivery.admitted",
      },
      {
        data: {
          deliveryId: `d_${interactionId}`,
          interactionId,
          responseId: `r_${interactionId}`,
          value,
        },
        type: "response.submitted",
      },
      { data: { responseId: `r_${interactionId}` }, type: "response.admitted" },
    );
  }

  /** Settles `interactionId`, decided by Bob's answer when it has one. */
  async function settle(
    interactionId: string,
    outcome: "accepted" | "declined" | "withdrawn",
    response?: Record<string, string>,
  ): Promise<void> {
    await commit({
      data: {
        interactionId,
        outcome,
        ...(response === undefined
          ? {}
          : { cause: { responseId: `r_${interactionId}` }, response }),
      },
      type: "interaction.settled",
    });
  }

  const calls = (method: string) => sent.filter((call) => call.method === method);
  const blocksOf = (call: Sent | undefined) => (call?.body.blocks ?? []) as BlockKitBlock[];
  return { answer, ask, blocksOf, calls, channel, commit, sent, settle };
}

const approval = (interactionId: string, name: string, input?: Record<string, string>) => ({
  call: { input, name },
  interactionId,
  request: {
    allowFreeform: false,
    display: "confirmation",
    kind: "approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "deny", label: "Deny" },
    ],
    prompt: `Approve ${name}?`,
  },
});

const dayQuestion = (interactionId = "q_day"): Asked => ({
  call: { name: "ask_question" },
  interactionId,
  request: {
    display: "select",
    kind: "question",
    options: [
      { id: "Saturday", label: "Saturday" },
      { id: "Sunday", label: "Sunday" },
    ],
    prompt: "Which day works for the review?",
  },
});

const freeformQuestion: Asked = {
  call: { name: "ask_question" },
  interactionId: "q_scope",
  request: { allowFreeform: true, kind: "question", prompt: "What should the review cover?" },
};

const budgetPrompt: Asked = {
  interactionId: "b_0",
  request: {
    display: "confirmation",
    kind: "budget",
    options: [
      { id: "approve", label: "Approve" },
      { id: "stop", label: "Stop" },
    ],
    prompt: "The turn reached its budget. Keep going?",
  },
};

/** Every eve action ID in `value`, however deeply its blocks nest them. */
function eveActionIds(value: unknown): string[] {
  return [...JSON.stringify(value).matchAll(/"action_id":"(eve_input[^"]*)"/gu)].map(
    (match) => match[1]!,
  );
}

const section = (text: string): BlockKitBlock => ({
  text: { text, type: "mrkdwn" },
  type: "section",
});

/** A renderer for answered and settled cards, naming the answer and who gave it. */
const doneRenderer = defineSlackRenderer({
  interactionCard(card, next) {
    const { answer, status } = card.interaction;
    if (status === "open" && answer === undefined) return next(card);
    const text = ["Done:", answer?.optionId ?? answer?.text ?? "none", card.answeredBy]
      .filter(Boolean)
      .join(" ");
    return { controls: { blocks: [section(text)], text } };
  },
});

describe("Slack input request cards", () => {
  it("posts a two-approval batch as one details message and one controls message", async () => {
    const plan = defineSlackRenderer({
      interactionCard(card, next) {
        const parts = next(card);
        const { call, status } = card.interaction;
        if (call?.name !== "plan-create" || status !== "open") return parts;
        return { ...parts, details: { blocks: [section("1. Draft the plan")], text: "Plan" } };
      },
    });
    const { ask, blocksOf, calls } = harness({ renderers: [plan] });

    await ask(approval("a_plan", "plan-create"), approval("a_deploy", "deploy", { env: "prod" }));

    const [details, controls, ...rest] = calls("thread.post");
    expect(rest).toEqual([]);
    expect(JSON.stringify(details?.body)).toContain("1. Draft the plan");
    expect(JSON.stringify(details?.body)).toContain("prod");
    expect(eveActionIds(details?.body)).toEqual([]);
    expect(blocksOf(controls)).toHaveLength(2);
    expect(eveActionIds(controls?.body)).toHaveLength(4);
  });

  it("posts relabeled controls nested in a renderer's blocks, and they decode to the request", async () => {
    const nested = defineSlackRenderer({
      interactionCard(card, next) {
        const parts = next(card);
        if (card.interaction.status !== "open") return parts;
        const [cardBlock] = parts.controls.blocks as [{ actions: Record<string, unknown>[] }];
        const elements = cardBlock.actions.reverse().map((button) => ({
          ...button,
          text: { text: button.value === "approve" ? "Ship it" : "Hold", type: "plain_text" },
        }));
        const blocks = [{ child_blocks: [{ elements, type: "actions" }], type: "container" }];
        return { ...parts, controls: { ...parts.controls, blocks } };
      },
    });
    const { ask, blocksOf, calls } = harness({ renderers: [nested] });

    await ask(approval("a_deploy", "deploy"));

    const [container] = blocksOf(calls("thread.post")[0]) as [
      { child_blocks: [{ elements: Record<string, string>[] }] },
    ];
    const ship = container.child_blocks[0].elements.find((element) => element.value === "approve")!;
    expect(ship.text).toMatchObject({ text: "Ship it" });
    expect(answerFromSlackAction({ actionId: ship.action_id!, value: ship.value })).toMatchObject({
      response: { interactionId: "a_deploy", optionId: "approve" },
    });
  });

  it("updates a card when its answer is admitted, before the batch settles", async () => {
    const { answer, ask, blocksOf, calls } = harness();
    await ask(approval("a_one", "deploy"), approval("a_two", "migrate"));
    const [posted] = calls("thread.post");

    await answer("a_one", { optionId: "approve" });

    const [update, ...more] = calls("chat.update");
    expect(more).toEqual([]);
    const [answered, neighbor] = blocksOf(update);
    expect(JSON.stringify(answered)).toContain("Approve");
    expect(JSON.stringify(answered)).toContain("<@U_BOB>");
    expect(eveActionIds(answered)).toEqual([]);
    expect(neighbor).toEqual(blocksOf(posted)[1]);
  });

  it.each([
    { name: "an answered approval", outcome: "accepted" as const, shows: "Done: approve U_BOB" },
    { name: "an approval no longer needed", outcome: "withdrawn" as const, shows: "Done: none" },
  ])("settles $name with the renderer's blocks", async ({ outcome, shows }) => {
    const { answer, ask, blocksOf, calls, channel, settle } = harness({
      renderers: [doneRenderer],
    });
    await ask(approval("a_deploy", "deploy", { env: "prod" }));

    if (outcome === "accepted") {
      await answer("a_deploy", { optionId: "approve" });
      await settle("a_deploy", outcome, { optionId: "approve" });
    } else {
      await settle("a_deploy", outcome);
    }

    // The settlement renders what the admitted answer already showed, so it updates nothing.
    expect(calls("chat.update").map((update) => blocksOf(update))).toEqual([[section(shows)]]);
    // The details message posted first, as `ts_1`.
    expect(calls("chat.delete").map((call) => call.body.ts)).toEqual(["ts_1"]);
    expect(channel.state.interactionCards).toEqual([]);
  });

  it("renders a direct-message request through the hook once, keeping its route", async () => {
    const approvalChannel = vi.fn(() => "direct-message" as const);
    const privately = defineSlackRenderer({
      interactionCard(card, next) {
        const parts = next(card);
        const { answer, status } = card.interaction;
        if (card.destination !== "direct-message" || card.audience !== "private") return parts;
        if (status !== "open" || answer !== undefined) return parts;
        const [cardBlock] = parts.controls.blocks;
        const blocks = [{ ...cardBlock, body: { text: "*Private review*", type: "mrkdwn" } }];
        return { ...parts, controls: { ...parts.controls, blocks } };
      },
    });
    const { answer, ask, calls, settle } = harness({ approvalChannel, renderers: [privately] });
    await ask(approval("a_deploy", "deploy"));

    const [controls] = calls("chat.postMessage").filter((call) => call.body.blocks !== undefined);
    expect(controls?.body.channel).toBe("D_ALICE");
    expect(JSON.stringify(controls?.body)).toContain("Private review");
    expect(eveActionIds(controls?.body)[0]).toMatch(/^eve_input:route:C1:1\.0:tool-approval:/u);

    await answer("a_deploy", { optionId: "approve" });
    await settle("a_deploy", "accepted", { optionId: "approve" });

    expect(approvalChannel).toHaveBeenCalledOnce();
    expect(calls("chat.update").map((update) => [update.body.channel, update.body.text])).toEqual([
      ["D_ALICE", "Answered: Approve"],
      ["C1", "Approved by <@U_BOB>."],
    ]);
  });

  const invalid: {
    readonly name: string;
    readonly render: (parts: SlackInteractionCardParts) => SlackInteractionCardParts;
  }[] = [
    { name: "drops eve's controls", render: (parts) => controls(parts, [section("Approve?")]) },
    {
      name: "duplicates eve's controls",
      render: (parts) => controls(parts, [...parts.controls.blocks, ...parts.controls.blocks]),
    },
    {
      name: "invents an eve action ID",
      render: (parts) =>
        controls(parts, [
          ...parts.controls.blocks,
          {
            elements: [{ action_id: "eve_input:other:button:0", type: "button", value: "approve" }],
            type: "actions",
          },
        ]),
    },
    {
      name: "changes a control's value",
      render: (parts) =>
        controls(
          parts,
          JSON.parse(JSON.stringify(parts.controls.blocks).replace('"approve"', '"deny"')),
        ),
    },
    {
      name: "puts eve's controls in its details",
      render: (parts) => ({ ...parts, details: parts.controls }),
    },
    {
      name: "posts more than 50 blocks",
      render: (parts) =>
        controls(parts, [
          ...parts.controls.blocks,
          ...Array.from({ length: 50 }, () => section("x")),
        ]),
    },
  ];

  it.each(invalid)("posts eve's default when a renderer $name", async ({ render }) => {
    const styled = harness({
      renderers: [defineSlackRenderer({ interactionCard: (card, next) => render(next(card)) })],
    });
    const plain = harness();

    await styled.ask(approval("a_deploy", "deploy"));
    await plain.ask(approval("a_deploy", "deploy"));

    expect(styled.calls("thread.post")).toEqual(plain.calls("thread.post"));
  });

  it.each([
    {
      name: "keeps eve's controls on an answered card",
      render: (
        card: SlackInteractionCard,
        next: (card: SlackInteractionCard) => SlackInteractionCardParts,
      ) => {
        const { answer: _answer, ...open } = card.interaction;
        return next({ ...card, interaction: { ...open, status: "open" } });
      },
    },
    {
      name: "throws at settlement",
      render: (
        card: SlackInteractionCard,
        next: (card: SlackInteractionCard) => SlackInteractionCardParts,
      ) => {
        if (card.interaction.status === "settled") throw new Error("renderer bug");
        return next(card);
      },
    },
  ])("settles with eve's default when a renderer $name", async ({ render }) => {
    const { ask, blocksOf, calls, settle } = harness({
      renderers: [defineSlackRenderer({ interactionCard: render })],
    });
    await ask(approval("a_deploy", "deploy"));

    await settle("a_deploy", "withdrawn");

    const [update] = calls("chat.update");
    expect(eveActionIds(update?.body)).toEqual([]);
    expect(JSON.stringify(blocksOf(update))).toContain("No longer needed");
  });

  it("falls back to the one-block default when a settled card outgrows its posted size", async () => {
    const tall = defineSlackRenderer({
      interactionCard(card, next) {
        if (card.interaction.status === "open") return next(card);
        return { controls: { blocks: [section("a"), section("b"), section("c")], text: "Done" } };
      },
    });
    const { ask, blocksOf, calls, settle } = harness({ renderers: [tall] });
    await ask(approval("a_deploy", "deploy"));

    await settle("a_deploy", "withdrawn");

    const blocks = blocksOf(calls("chat.update")[0]);
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks)).toContain("No longer needed");
  });

  it("posts and updates once more with eve's default when Slack rejects a rendered message", async () => {
    const styled = defineSlackRenderer({
      interactionCard(card, next) {
        const parts = next(card);
        const [first] = parts.controls.blocks;
        return controls(parts, [{ ...first, title: { text: "Styled", type: "plain_text" } }]);
      },
    });
    const { ask, calls, settle } = harness({
      rejects: ({ body }) => JSON.stringify(body).includes("Styled"),
      renderers: [styled],
    });

    await ask(approval("a_deploy", "deploy"));
    await settle("a_deploy", "withdrawn");

    const posts = calls("thread.post");
    expect(posts.map((post) => JSON.stringify(post.body).includes("Styled"))).toEqual([
      true,
      false,
    ]);
    const updates = calls("chat.update");
    expect(updates.map((update) => JSON.stringify(update.body).includes("Styled"))).toEqual([
      true,
      false,
    ]);
    expect(updates.map((update) => update.body.ts)).toEqual(["ts_1", "ts_1"]);
  });

  it.each([
    { name: "a withdrawn question", asked: dayQuestion(), shows: "No longer needed" },
    { name: "a settled budget prompt", asked: budgetPrompt, shows: "Approve" },
  ])("retires $name's buttons", async ({ asked, shows }) => {
    const { answer, ask, blocksOf, calls, settle } = harness();
    await ask(asked);
    expect(eveActionIds(calls("thread.post")[0]?.body).length).toBeGreaterThan(0);

    if (asked === budgetPrompt) {
      await answer(asked.interactionId, { optionId: "approve" });
      await settle(asked.interactionId, "accepted", { optionId: "approve" });
    } else {
      await settle(asked.interactionId, "withdrawn");
    }

    const [update] = calls("chat.update");
    expect(eveActionIds(update?.body)).toEqual([]);
    expect(JSON.stringify(blocksOf(update))).toContain(shows);
  });

  it("answers a freeform question without touching the question grouped beside it", async () => {
    const { answer, ask, blocksOf, calls } = harness();
    await ask(freeformQuestion, dayQuestion());
    const posted = blocksOf(calls("thread.post")[0]);
    expect(posted).toHaveLength(4);

    await answer("q_scope", { text: "Mostly the billing migration" });

    const [answered, ...neighbor] = blocksOf(calls("chat.update")[0]);
    expect(JSON.stringify(answered)).toContain("Mostly the billing migration");
    expect(JSON.stringify(answered)).toContain("<@U_BOB>");
    expect(neighbor).toEqual(posted.slice(2));
  });
});

function controls(
  parts: SlackInteractionCardParts,
  blocks: readonly BlockKitBlock[],
): SlackInteractionCardParts {
  return { ...parts, controls: { ...parts.controls, blocks } };
}
