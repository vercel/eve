import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "#protocol/session-event.js";
import type { InteractionSettledData } from "#protocol/session-events/families/interaction.js";
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
    /** Binds the session to a code channel instead of a thread. */
    readonly codeChannel?: boolean;
    readonly renderers?: readonly SlackRenderer[];
    /** Slack's error code for a call it fails, or `NETWORK` for one that never gets an answer. */
    readonly fails?: (sent: Sent) => string | undefined;
    /** Event types whose handlers don't run, as when a renderer skips `next()` for them. */
    readonly skip?: readonly string[];
  } = {},
) {
  const sent: Sent[] = [];
  let ts = 0;
  const respond = (method: string, body: Record<string, unknown>) => {
    sent.push({ body, method });
    const error = options.fails?.({ body, method });
    if (error === NETWORK) throw new TypeError("fetch failed");
    if (error !== undefined) return { error, ok: false };
    ts += 1;
    return { channel: { id: "D_ALICE" }, ok: true, ts: `ts_${ts}` };
  };
  const state: SlackChannelState = {
    audience: "public",
    channelId: "C1",
    slackUsersByPrincipal: { p_bob: "U_BOB" },
    teamId: null,
    threadTs: options.codeChannel === true ? null : "1.0",
    triggeringUserId: "U_ALICE",
  };
  // A code channel is the session itself, with no thread root, as production state records it.
  if (options.codeChannel === true) state.codeChannel = true;
  const channel = {
    slack: {
      channelId: "C1",
      codeChannel: options.codeChannel === true,
      request: async (method: string, body: Record<string, unknown>) => respond(method, body),
      threadTs: options.codeChannel === true ? "" : "1.0",
    },
    state,
    thread: {
      async post(message: string | Record<string, unknown>) {
        const response = respond(
          "thread.post",
          typeof message === "string" ? { text: message } : message,
        );
        if (!response.ok) {
          throw Object.assign(new Error("Slack refused the message"), { response });
        }
        return { id: response.ts };
      },
      async postEphemeral(user: string, text: string) {
        const response = respond("chat.postEphemeral", { text, user });
        if (!response.ok)
          throw Object.assign(new Error("Slack refused the ephemeral"), { response });
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
    // State persists as JSON between workflow steps, so each commit starts from a round trip.
    channel.state = JSON.parse(JSON.stringify(channel.state)) as SlackChannelState;
    const line = position;
    foldLine(view, { at, facts }, line, { retention: "operational" });
    position += 1;
    const ctx = {
      channel,
      position: { index: 0, line },
      session: { auth: {}, id: "s_0" },
      view: snapshotOf(view),
    };
    for (const fact of facts) {
      if (options.skip?.includes(fact.type)) continue;
      const handler = events[fact.type as keyof typeof events] as
        | ((event: SessionEvent, ctx: unknown) => Promise<void>)
        | undefined;
      await handler?.(fact, ctx);
    }
  }

  let started = false;
  /** Opens `requests` in one commit, as one step asking them together. */
  async function ask(...requests: Asked[]): Promise<void> {
    const first = !started;
    const start: SessionEvent[] = !first
      ? []
      : [
          { data: { cause: { deliveryId: "d_0" }, follows: null, turnId }, type: "turn.started" },
          { data: { owner: { turnId }, runId }, scope, type: "model.requested" },
        ];
    if (first) {
      await commit(
        { data: {}, type: "session.started" },
        { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
      );
    }
    started = true;
    await commit(
      ...start,
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
      ...(first
        ? [{ data: { outcome: "completed", runId }, scope, type: "model.settled" } as SessionEvent]
        : []),
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

  /** An answer to `interactionId`, submitted and admitted; Bob's unless `principal` says. */
  async function answer(
    interactionId: string,
    value: Record<string, string>,
    principal = "p_bob",
  ): Promise<void> {
    await commit(
      {
        data: { deliveryId: `d_${interactionId}`, principal: { id: principal, type: "user" } },
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

  /** Settles `interactionId` in its own commit. */
  async function settle(...args: Parameters<typeof settled>): Promise<void> {
    await commit(settled(...args));
  }

  const calls = (method: string) => sent.filter((call) => call.method === method);
  const blocksOf = (call: Sent | undefined) => (call?.body.blocks ?? []) as BlockKitBlock[];
  return { answer, ask, blocksOf, calls, channel, commit, sent, settle };
}

const NETWORK = "network";

/** `principal`'s answer `approve` to `interactionId`, submitted but not yet admitted. */
function submitted(responseId: string, interactionId: string, principal: string): SessionEvent[] {
  return [
    {
      data: { deliveryId: `d_${responseId}`, principal: { id: principal, type: "user" } },
      type: "delivery.admitted",
    },
    {
      data: {
        deliveryId: `d_${responseId}`,
        interactionId,
        responseId,
        value: { optionId: "approve" },
      },
      type: "response.submitted",
    },
  ];
}

/** `interactionId`'s settlement, decided by the answer `answer` recorded when `response` is given. */
function settled(
  interactionId: string,
  outcome: "accepted" | "declined" | "withdrawn",
  response?: Record<string, string>,
): SessionEvent {
  const data: { -readonly [K in keyof InteractionSettledData]: InteractionSettledData[K] } = {
    interactionId,
    outcome,
  };
  if (response !== undefined) {
    data.cause = { responseId: `r_${interactionId}` };
    data.response = response;
  }
  return { data, type: "interaction.settled" };
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

/** A renderer that retitles every card, which a test's Slack can refuse by that title. */
const styledRenderer = defineSlackRenderer({
  interactionCard(card, next) {
    const parts = next(card);
    const [first] = parts.controls.blocks;
    return controls(parts, [{ ...first, title: { text: "Styled", type: "plain_text" } }]);
  },
});

const refusesStyled = ({ body }: Sent) =>
  JSON.stringify(body).includes("Styled") ? "invalid_blocks" : undefined;

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
      ["C1", "Answered: Approve by <@U_BOB>."],
    ]);
  });

  const invalid: {
    readonly name: string;
    readonly render: (parts: SlackInteractionCardParts) => SlackInteractionCardParts;
  }[] = [
    {
      name: "changes eve's controls",
      render: (parts) =>
        controls(
          parts,
          JSON.parse(JSON.stringify(parts.controls.blocks).replace('"approve"', '"deny"')),
        ),
    },
    {
      name: "returns blocks JSON can't hold",
      render: (parts) => controls(parts, [...parts.controls.blocks, { size: 1n, type: "divider" }]),
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

  it("settles with eve's one-block default when the renderer's card would pass 50 blocks", async () => {
    const tall = defineSlackRenderer({
      interactionCard(card, next) {
        if (card.interaction.status === "open") return next(card);
        return { controls: { blocks: [section("a"), section("b"), section("c")], text: "Done" } };
      },
    });
    const { ask, blocksOf, calls, settle } = harness({ renderers: [tall] });
    await ask(...Array.from({ length: 50 }, (_, index) => approval(`a_${index}`, "deploy")));

    await settle("a_0", "withdrawn");

    const [update] = calls("chat.update");
    expect(blocksOf(update)).toHaveLength(50);
    expect(JSON.stringify(blocksOf(update)[0])).toContain("No longer needed");
    expect(update?.body.text).toBe("No longer needed");
  });

  it.each([
    { questions: 1, blocks: 2, shows: "eve's default" },
    { questions: 50, blocks: 50, shows: "only eve's controls" },
  ])(
    "shows $shows again when a refused answer reopens a compact card whose renderer then throws",
    async ({ blocks, questions }) => {
      let broken = false;
      // One block per open question, where eve's default needs a prompt and a select: two.
      const compact = defineSlackRenderer({
        interactionCard(card, next) {
          const parts = next(card);
          const { answer, status } = card.interaction;
          if (status !== "open" || answer !== undefined) return parts;
          if (broken) throw new Error("renderer bug");
          return controls(parts, [{ child_blocks: parts.controls.blocks, type: "container" }]);
        },
      });
      const { answer, ask, blocksOf, calls, commit } = harness({ renderers: [compact] });
      await ask(...Array.from({ length: questions }, (_, index) => dayQuestion(`q_${index}`)));
      await answer("q_0", { optionId: "Saturday" });
      broken = true;

      await commit({
        data: { outcome: "refused", responseId: "r_q_0" },
        type: "response.settled",
      });

      const update = calls("chat.update").at(-1);
      expect(blocksOf(update)).toHaveLength(blocks);
      expect(eveActionIds(blocksOf(update))).toContain("eve_input:q_0");
    },
  );

  it("posts and updates once more with eve's default when Slack rejects a rendered message", async () => {
    const { ask, calls, settle } = harness({ fails: refusesStyled, renderers: [styledRenderer] });

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
    { error: "rate_limited", name: "rate limits an update" },
    { error: NETWORK, name: "never answers an update" },
  ])("doesn't resend eve's default when Slack $name", async ({ error }) => {
    const { ask, calls, channel, settle } = harness({
      fails: ({ method }) => (method === "chat.update" ? error : undefined),
      renderers: [doneRenderer],
    });
    await ask(approval("a_deploy", "deploy"));

    await settle("a_deploy", "withdrawn");

    expect(calls("chat.update")).toHaveLength(1);
    expect(channel.state.interactionCards).toEqual([]);
  });

  it("doesn't repost a batch when its post never gets an answer", async () => {
    const { ask, calls } = harness({ fails: () => NETWORK, renderers: [styledRenderer] });

    await expect(ask(approval("a_deploy", "deploy"))).rejects.toThrow("fetch failed");

    expect(calls("thread.post")).toHaveLength(1);
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

  it("shows a typed answer literally while crediting the person who gave it", async () => {
    const { answer, ask, blocksOf, calls } = harness();
    await ask({
      ...freeformQuestion,
      request: { ...freeformQuestion.request, prompt: "Scope & <!here>?" },
    });

    await answer("q_scope", { text: "<!channel> & <@U1>" });

    const [update] = calls("chat.update");
    expect(update?.body.text).toBe("Answered: &lt;!channel&gt; &amp; &lt;@U1&gt;");
    expect(blocksOf(update)).toEqual([
      {
        text: {
          text: "Scope &amp; &lt;!here&gt;?\n:white_check_mark: *&lt;!channel&gt; &amp; &lt;@U1&gt;* by <@U_BOB>",
          type: "mrkdwn",
        },
        type: "section",
      },
    ]);
  });

  it("withdraws two grouped approvals settled in one commit with one update", async () => {
    const { ask, blocksOf, calls, channel, commit } = harness();
    await ask(approval("a_one", "deploy"), approval("a_two", "migrate"));

    await commit(settled("a_one", "withdrawn"), settled("a_two", "withdrawn"));

    const [update, ...more] = calls("chat.update");
    expect(more).toEqual([]);
    expect(eveActionIds(update?.body)).toEqual([]);
    expect(blocksOf(update)).toHaveLength(2);
    expect(channel.state.interactionCards).toEqual([]);
  });

  it("settles an accepted approval and a withdrawn neighbor from one commit", async () => {
    const { answer, ask, blocksOf, calls, channel, commit } = harness();
    await ask(approval("a_one", "deploy"), approval("a_two", "migrate"));
    await answer("a_one", { optionId: "approve" });

    // A message steering the turn withdraws the neighbor as the answer decides the first.
    await commit(
      settled("a_one", "accepted", { optionId: "approve" }),
      settled("a_two", "withdrawn"),
    );

    const update = calls("chat.update").at(-1);
    expect(eveActionIds(update?.body)).toEqual([]);
    const [accepted, withdrawn] = blocksOf(update);
    expect(JSON.stringify(accepted)).toContain("<@U_BOB>");
    expect(JSON.stringify(withdrawn)).toContain("No longer needed");
    expect(channel.state.interactionCards).toEqual([]);
  });

  it("leaves a request that settled in the same commit to interaction.settled", async () => {
    // As if a renderer skipped `next()` on `interaction.settled`: no handler writes the card.
    const { ask, calls, commit } = harness({ skip: ["interaction.settled"] });
    await ask(approval("a_deploy", "deploy"));

    await commit(
      {
        data: { deliveryId: "d_bob", principal: { id: "p_bob", type: "user" } },
        type: "delivery.admitted",
      },
      {
        data: {
          deliveryId: "d_bob",
          interactionId: "a_deploy",
          responseId: "r_a_deploy",
          value: { optionId: "approve" },
        },
        type: "response.submitted",
      },
      { data: { responseId: "r_a_deploy" }, type: "response.admitted" },
      settled("a_deploy", "accepted", { optionId: "approve" }),
      { data: { outcome: "applied", responseId: "r_a_deploy" }, type: "response.settled" },
    );

    expect(calls("chat.update")).toEqual([]);
  });

  it("keeps the controls messages posted before a later group fails", async () => {
    let postsSeen = 0;
    const { ask, calls, channel } = harness({
      fails: ({ method }) => (method === "thread.post" && postsSeen++ === 1 ? NETWORK : undefined),
    });
    const approvals = Array.from({ length: 51 }, (_, index) => approval(`a_${index}`, "deploy"));

    await expect(ask(...approvals)).rejects.toThrow("fetch failed");

    expect(calls("thread.post")).toHaveLength(2);
    expect(channel.state.interactionCards?.map((record) => record.requests.length)).toEqual([50]);
  });

  it("regroups a refused batch's defaults across as many messages as they need", async () => {
    // One block per question, where eve's default needs a prompt and a select: two.
    const compact = defineSlackRenderer({
      interactionCard(card, next) {
        const parts = next(card);
        if (card.interaction.status !== "open") return parts;
        const blocks = [{ child_blocks: parts.controls.blocks, type: "container" }];
        return controls(parts, blocks);
      },
    });
    const { ask, blocksOf, calls, channel } = harness({
      fails: ({ body }) =>
        JSON.stringify(body).includes("container") ? "invalid_blocks" : undefined,
      renderers: [compact],
    });

    await ask(...Array.from({ length: 30 }, (_, index) => dayQuestion(`q_${index}`)));

    expect(calls("thread.post").map((post) => blocksOf(post).length)).toEqual([30, 50, 10]);
    expect(channel.state.interactionCards?.map((record) => record.requests.length)).toEqual([
      25, 5,
    ]);
  });

  it("brings the controls back when an admitted answer is refused", async () => {
    const { answer, ask, blocksOf, calls, commit } = harness();
    await ask(approval("a_deploy", "deploy"));
    const [posted] = calls("thread.post");
    await answer("a_deploy", { optionId: "approve" });
    expect(eveActionIds(calls("chat.update")[0]?.body)).toEqual([]);

    await commit({
      data: { outcome: "refused", reason: "Only owners approve.", responseId: "r_a_deploy" },
      type: "response.settled",
    });

    expect(blocksOf(calls("chat.update")[1])).toEqual(blocksOf(posted));
  });

  it("deletes a details message shared by two controls messages once both settle", async () => {
    // Two blocks of controls per approval and one of details: 26 approvals post one details
    // message and two controls messages.
    const tall = defineSlackRenderer({
      interactionCard(card, next) {
        const parts = next(card);
        if (card.interaction.status !== "open") return parts;
        return controls(parts, [...parts.controls.blocks, section("Needs an owner")]);
      },
    });
    const { ask, calls, channel, commit, settle } = harness({ renderers: [tall] });
    const approvals = Array.from({ length: 26 }, (_, index) =>
      approval(`a_${index}`, "deploy", { env: "prod" }),
    );
    await ask(...approvals);
    expect(calls("thread.post")).toHaveLength(3);

    await commit(
      ...approvals.slice(0, 25).map(({ interactionId }) => settled(interactionId, "withdrawn")),
    );
    expect(calls("chat.delete")).toEqual([]);

    await settle("a_25", "withdrawn");
    expect(calls("chat.delete").map((call) => call.body.ts)).toEqual(["ts_1"]);
    expect(channel.state.interactionCards).toEqual([]);
  });

  it("posts a direct-message request's default when Slack refuses the rendered one", async () => {
    const { ask, calls, channel } = harness({
      approvalChannel: () => "direct-message",
      fails: refusesStyled,
      renderers: [styledRenderer],
    });

    await ask(approval("a_deploy", "deploy"));

    const posts = calls("chat.postMessage").filter((call) => call.body.blocks !== undefined);
    expect(posts.map((post) => JSON.stringify(post.body).includes("Styled"))).toEqual([
      true,
      false,
    ]);
    expect(calls("chat.delete")).toEqual([]);
    expect(channel.state.interactionCards?.[0]?.channelId).toBe("D_ALICE");
  });

  it("credits nobody for an answer from a responder with no Slack user", async () => {
    const { answer, ask, calls } = harness();
    await ask(approval("a_deploy", "deploy"));

    await answer("a_deploy", { optionId: "approve" }, "p_unmapped");

    const [update] = calls("chat.update");
    expect(update?.body.text).toBe("Answered: Approve");
    expect(JSON.stringify(update?.body)).not.toContain("<@");
  });

  it("reads a declined approval the same on its card and its thread note", async () => {
    const { ask, calls, settle } = harness({ approvalChannel: () => "direct-message" });
    await ask(approval("a_deploy", "deploy"));

    await settle("a_deploy", "declined");

    expect(calls("chat.update").map((update) => update.body.text)).toEqual([
      "Declined",
      "Declined.",
    ]);
  });

  it("ignores cards recorded before the upgrade", async () => {
    const { ask, calls, channel, settle } = harness();
    await ask(approval("a_deploy", "deploy"));
    const legacy = channel.state as SlackChannelState & Record<string, unknown>;
    legacy.interactionCards = undefined;
    legacy.pendingApprovalCards = { a_deploy: { messageBlocks: [], messageTs: "ts_1" } };

    await settle("a_deploy", "withdrawn");

    expect(calls("chat.update")).toEqual([]);
  });

  it("brings the controls back even when the refusal notice fails", async () => {
    const { answer, ask, blocksOf, calls, commit } = harness({
      fails: ({ method }) => (method === "chat.postEphemeral" ? "user_not_in_channel" : undefined),
    });
    await ask(approval("a_deploy", "deploy"));
    const [posted] = calls("thread.post");
    await answer("a_deploy", { optionId: "approve" });

    await commit({
      data: { outcome: "refused", reason: "Only owners approve.", responseId: "r_a_deploy" },
      type: "response.settled",
    });

    expect(calls("chat.postEphemeral")).toHaveLength(1);
    expect(blocksOf(calls("chat.update")[1])).toEqual(blocksOf(posted));
  });

  it("shows only an admitted answer, crediting the person who gave it", async () => {
    const seen: unknown[] = [];
    const watching = defineSlackRenderer({
      interactionCard(card, next) {
        seen.push([card.interaction.answer?.optionId, card.answeredBy]);
        return next(card);
      },
    });
    const { ask, calls, commit } = harness({ renderers: [watching] });
    await ask(approval("a_deploy", "deploy"));

    // Bob's answer waits on a response policy while Carol's is refused.
    await commit(...submitted("r_bob", "a_deploy", "p_bob"));
    await commit(...submitted("r_carol", "a_deploy", "p_carol"), {
      data: { outcome: "refused", responseId: "r_carol" },
      type: "response.settled",
    });
    expect(calls("chat.update")).toEqual([]);
    expect(seen.at(-1)).toEqual([undefined, undefined]);

    await commit({ data: { responseId: "r_bob" }, type: "response.admitted" });
    expect(seen.at(-1)).toEqual(["approve", "U_BOB"]);
    expect(JSON.stringify(calls("chat.update")[0]?.body)).toContain("<@U_BOB>");
  });

  it("forgets a card a renderer never let eve settle once a later commit handles cards", async () => {
    const { ask, channel, commit } = harness({ skip: ["interaction.settled"] });
    await ask(approval("a_one", "deploy"));
    await commit(settled("a_one", "withdrawn"));
    expect(channel.state.interactionCards).toHaveLength(1);

    await ask(approval("a_two", "migrate"));

    expect(
      channel.state.interactionCards?.map((record) => record.requests[0]?.interactionId),
    ).toEqual(["a_two"]);
  });

  it.each([
    {
      channel: "D_ALICE",
      codeChannel: false,
      destination: "direct-message" as const,
      name: "a direct-message card",
      route: /^eve_input:route:C1:1\.0:tool-approval:/u,
    },
    {
      channel: "D_ALICE",
      codeChannel: true,
      destination: "direct-message" as const,
      name: "a code channel's direct-message card",
      route: /^eve_input:code:C1:tool-approval:/u,
    },
    {
      channel: "C1",
      codeChannel: true,
      destination: "thread" as const,
      name: "a code channel's card",
      route: /^eve_input:code:C1:tool-approval:/u,
    },
  ])(
    "keeps $name's route when a refused answer reopens it",
    async ({ channel, codeChannel, destination, route }) => {
      const { answer, ask, calls, commit, sent } = harness({
        approvalChannel: () => destination,
        codeChannel,
      });
      await ask(approval("a_deploy", "deploy"));
      await answer("a_deploy", { optionId: "approve" });

      await commit({
        data: { outcome: "refused", responseId: "r_a_deploy" },
        type: "response.settled",
      });

      // Clicks decode the session from the route, so a card outside the session's thread needs it.
      const posted = sent.find(
        (call) =>
          (call.method === "thread.post" || call.method === "chat.postMessage") &&
          eveActionIds(call.body).length > 0,
      );
      const reopened = calls("chat.update").at(-1);
      expect(reopened?.body.channel).toBe(channel);
      for (const message of [posted, reopened]) {
        const ids = eveActionIds(message?.body);
        expect(ids).toHaveLength(2);
        for (const id of ids) expect(id).toMatch(route);
      }
    },
  );
});

function controls(
  parts: SlackInteractionCardParts,
  blocks: readonly BlockKitBlock[],
): SlackInteractionCardParts {
  return { ...parts, controls: { ...parts.controls, blocks } };
}
