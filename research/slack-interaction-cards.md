---
issue: https://github.com/vercel/eve/issues/5462
status: proposed
last_updated: "2026-10-27"
---

# Slack interaction cards

Slack renderers can restyle the task card with a pure `taskCard(card, next)` hook, but approvals,
questions, and budget prompts have no equivalent. Changing how one looks means taking over
delivery in `interaction.opened`. This plan adds a pure `interactionCard(card, next)` hook. A
renderer chooses the blocks. eve keeps routing, batching, action IDs, authorization, and the card's
lifecycle. Paths are relative to `packages/eve/src/`.

## Problem

To restyle an approval today, a renderer calls `next()` in `interaction.opened` and patches what
eve posted. That depends on internals:

- **Batching.** `requestBatchOf` groups one commit's requests. `buildInteractionPosts`
  (`public/channels/slack/approval-cards.ts`) splits each approval with tool input into a details
  message and a controls message, then groups them under Slack's 50-block cap. Neither is public.
- **Finding the message.** The renderer has to read `state.pendingApprovalCards` to learn which
  message holds which request.
- **Action IDs.** Clicks route by an implicit wire format in `public/channels/slack/hitl.ts`.
  `encodeHitlActionId` mints `eve_input:[route:<channel>:<thread>:][tool-approval:]<id>`,
  `buildCardButton` adds `:button:<n>`, and freeform buttons use `eve_input_freeform:`. A
  renderer has to parse this to find a request's block, and reuse it so clicks still route.
- **Settlement.** `settleApprovalCard` rewrites the blocks recorded at post time, so styling added
  afterward is lost when the approval resolves.
- **DM delivery.** `deliverPrivateInteraction` calls `renderInteractionPostParts` directly, outside
  any renderer.

Restyling also tempts authors to put tool input beside the buttons. Slack echoes the whole
controls message back in every `block_actions` callback, which is why eve posts tool input as a
separate details message. In the issue's case, an inline nine-step plan made the echoed payload
about 26k characters.

`approval.prompt` customizes the prompt text but not structured blocks. The block helpers
(`renderInteractionBlocks`, `answerFromSlackAction`) leave batching, routing, authorization, and
settlement to the app.

Reading the settlement code turned up more problems:

1. **Cards retire in different places.** Approvals retire on `interaction.settled`, from the
   recorded blocks. Questions retire in the click webhook (`public/channels/slack/interactions.ts`).
   A button or select question rewrites the blocks Slack echoes back. A freeform answer replaces the
   whole message with one answered section (`settleFreeformCard`), which also erases any other
   request grouped in that message. The webhook has no session view, so it can't call a hook that
   takes an `Interaction`.
2. **Some cards keep live buttons after they end.** `recordApprovalCards` tracks only approvals,
   and `settleApproval` returns early for every other kind. A question that is withdrawn or answered
   by a typed reply, and every budget prompt, keeps its controls.
3. **Durable state repeats blocks.** Each approval in a message records its own copy of that whole
   message's blocks (`SlackPendingApprovalCard.messageBlocks`).

## Authoring API

```ts
/** One input request as eve is about to post or update it. */
export interface SlackInteractionCard {
  /**
   * The request, read from the session: `status`, `outcome`, `call` (with `input`), and `answer`.
   * While open, `answer` is the answer that stands until the request settles, if any.
   */
  readonly interaction: Interaction;
  /** Where eve posts it, as `approvalChannel` decided. */
  readonly destination: SlackApprovalChannel;
  /**
   * Who reads the message. A direct message is always `private`; a thread request has the
   * thread's audience. Same meaning as `TaskCard.audience`.
   */
  readonly audience: ChannelAudience;
  /** The Slack user whose answer stands or decided the request, when known. */
  readonly answeredBy?: string;
  /** Session snapshot, for the `eve/events` selectors. */
  readonly view: SessionView;
}

export interface SlackInteractionMessage {
  readonly blocks: readonly BlockKitBlock[];
  readonly text: string;
}

export interface SlackInteractionCardParts {
  /** The message holding eve's controls. Slack echoes it back on every click, so keep it small. */
  readonly controls: SlackInteractionMessage;
  /** Posted as a separate message before the controls, and deleted once the request settles. */
  readonly details?: SlackInteractionMessage;
}

export interface SlackRenderer {
  // received, events, taskCard ...
  readonly interactionCard?: (
    card: SlackInteractionCard,
    next: (card: SlackInteractionCard) => SlackInteractionCardParts,
  ) => SlackInteractionCardParts;
}
```

The issue's example, with no second `chat.update`, no state lookups, and no action-ID parsing:

```ts title="agent/channels/slack.ts"
import { defineSlackRenderer, slackChannel } from "eve/channels/slack";

const plan = defineSlackRenderer({
  interactionCard(card, next) {
    const parts = next(card);
    const { call, status } = card.interaction;
    if (call?.name !== "plan-create" || status !== "open") return parts;
    return { ...parts, details: renderPlanSteps(call.input) };
  },
});

export default slackChannel({ renderers: [plan] });
```

Renderers compose like `taskCard`: the first one is outermost, and the chain ends at eve's
default. `next` accepts a changed card, for example a shorter `interaction.request.prompt` for
eve's default to render. eve's default renders an open request with controls as
`renderInteractionPostParts` does today. For an answered or settled request, it renders a single
block that names the answer and, when known, who gave it.

The issue's sketch differs in three ways:

- **No separate `state` field.** `Interaction` already carries `status`, `outcome`, and `answer`.
- **No `null` return.** An open request with no controls can't be answered, and it would hold the
  turn. To keep a request out of the thread, use `approvalChannel`. To deliver requests yourself,
  skip `next()` in `interaction.opened`. That takes over the whole batch, because eve's default
  posts the batch on its first `interaction.opened`.
- **`answeredBy` instead of a principal.** It's the Slack user ID, resolved through `responderOf`
  and `slackUsersByPrincipal`, so the hook doesn't need channel state.

## Semantics

```text
interaction.opened ─▶ route (approvalChannel) ─▶ interactionCard per request ─▶ check
                                                                   │
                   group details, then controls, under 50 blocks ◀─┘ ─▶ post, record

response.admitted / response.settled / interaction.settled
                   ─▶ interactionCard for the changed request ─▶ check ─▶ chat.update if changed
                   ─▶ delete details once none of its requests is open
```

- **Scope.** The hook runs for every interaction except sign-ins. That covers approvals,
  questions, and budget prompts, plus any kind a newer eve adds. Sign-ins carry a credential and
  keep their restricted delivery path.
- **What eve still owns.** Routing through `approvalChannel`, batching, posting, the 50-block
  grouping, card bookkeeping, encoding action IDs, `onAnswers` and approval response policies, the
  details message's lifecycle, and the DM announcement.
- **When the hook runs.** eve renders a request when it opens, and again when its row changes: an
  answer is admitted, an answer is refused, or the request settles. Approvals in one step settle
  together once each has a standing answer, and relayed requests wait for their asker's batch. So
  the admitted answer, not the settlement, is when a person sees their click land. eve updates a
  message only when its rendered blocks changed.
- **Actions.** eve renders its own default controls from the original `Interaction`, outside the
  chain. It then checks the chain's result against them:
  - **Open, unanswered.** `controls` must hold exactly eve's interactive elements: every
    `eve_input:` and `eve_input_freeform:` action ID once, each with the same `value` or option
    values, and no others. A renderer can relabel elements, reorder them, or nest them in its own
    blocks; the check walks nested blocks.
  - **Answered or settled.** `controls` must hold no eve action IDs.
  - **Always.** `details` holds no eve action IDs, and each part fits in 50 blocks.
- **Failures.** If the hook throws or fails the check, eve logs it and renders that request with
  its default. If Slack rejects a rendered message (`invalid_blocks`, a size limit), eve posts or
  updates that message once more with its defaults. A dropped request would hold the turn, so a
  default card beats none. `taskCard` differs: a card that throws stays as last written, since a
  stale card holds nothing up.
- **Block limits.** eve records the number of blocks each request's controls had when posted. A
  rendering that would grow beyond that number falls back to eve's one-block default for that
  request. Other requests in the message keep their recorded blocks, so a message never grows past
  50 blocks after posting.
- **DM delivery.** The hook runs for requests that `approvalChannel` sends to a DM, with
  `destination: "direct-message"`. eve records the destination, so it never calls `approvalChannel`
  again when it re-renders.
- **No longer active.** A click after the session has gone runs in the webhook, where there's no
  view. That card keeps today's rewrite of the echoed blocks. If a renderer nested eve's controls,
  this path can replace the whole message with the answer line.
- **Purity.** The hook is synchronous and makes no Slack calls.

## Boundaries

- Card bookkeeping replaces `pendingApprovalCards` with a record per message: its `ts` and
  channel, its details message, its destination, and each request's recorded controls blocks,
  stored once. eve records every interaction except sign-ins, not just approvals. eve is pre-1.0,
  so cards posted before the upgrade get no compatibility shim and keep their live buttons.
- Question and freeform cards update from session events, not the click webhook, so a freeform
  answer no longer erases its neighbors.
- eve composes `interactionCard` before it builds its default `interaction.opened`,
  `response.admitted`, `response.settled`, and `interaction.settled` handlers, and passes the
  composed hook into them. Slack's renderer events gain `response.admitted`, which channels already
  receive. A renderer whose handler for one of those events skips `next()` also skips eve's card
  update for it, as with every other default.
- Slack-only. No other channel has a renderer chain yet. `SlackInteractionCard` holds mostly
  channel-neutral data, so a later chain on another channel could reuse its shape.

## Alternatives

- **Restyle after `next()` in `interaction.opened`.** This is what the issue's author did, with
  the fragile coupling described above.
- **eve appends the controls, and the renderer returns only the blocks around them.** That's
  safer, but eve's approval controls are a single Slack `card` block with its buttons inside. A
  renderer couldn't restyle the card's title or body, which is the most likely customization.
  Checking the action IDs keeps that flexibility.
- **Re-render every request in a message on each change.** It's simpler to describe, but a
  renderer can shrink a request when open and grow it when settled. Re-rendering only the changed
  request against its recorded size keeps the 50-block guarantee.
- **A channel-neutral hook on the shared interaction prompt layer.** Deferred until another
  channel has a renderer chain to host it.

## Validation

Slack has no e2e fixture, and e2e must not depend on external services, so this change uses unit
tests on the chain and posting functions, plus focused cases in
`public/channels/slack/input-response.integration.test.ts` and the Slack conformance suites:

- A renderer that adds details for one tool still posts a two-approval batch as one details
  message and one controls message.
- Clicks on renderer-styled and nested controls decode to the right interaction.
- An admitted answer updates the card before the batch settles.
- Settled cards use the renderer's blocks, for an answered approval and for one that is no longer
  needed.
- DM delivery uses the hook and keeps its route.
- A renderer that drops, duplicates, or invents eve action IDs, or keeps them on an answered card,
  falls back to the default. A renderer that throws at settlement falls back the same way.
- A settled rendering larger than its recorded size falls back to the one-block default.
- A message Slack rejects is sent once more with eve's defaults.
- A withdrawn question and a settled budget prompt lose their buttons. A freeform answer leaves
  grouped neighbors intact.
- Docs: the Customize rendering and Human-in-the-loop sections of `docs/channels/slack.mdx`.
