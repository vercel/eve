---
issue: https://github.com/vercel/eve/issues/5462
status: proposed
last_updated: "2026-10-27"
---

# Slack interaction cards

Slack renderers can restyle the task card with a pure `taskCard(card, next)` hook, but approvals,
questions, and budget prompts have no equivalent. Changing how one looks means taking over
delivery in `interaction.opened`. This plan adds a pure `interactionCard(card, next)` hook. A
renderer chooses the blocks. eve keeps routing, batching, action IDs, authorization, and
settlement. Paths are relative to `packages/eve/src/`.

## Problem

To restyle an approval today, a renderer calls `next()` in `interaction.opened` and patches what
eve posted. That depends on internals:

- **Batching.** `requestBatchOf` groups one commit's requests. `buildInteractionPosts`
  (`public/channels/slack/approval-cards.ts`) splits each one into a details message and a controls
  message, then groups them under Slack's 50-block cap. Neither is public.
- **Finding the message.** The renderer has to read `state.pendingApprovalCards` to learn which
  message holds which request.
- **Action IDs.** Clicks route by an implicit `eve_input:[route:…:]tool-approval:<id>:button:<n>`
  format (`encodeHitlActionId` in `public/channels/slack/hitl.ts`). A renderer has to parse it to
  find a request's block and reuse it to keep clicks working.
- **Settlement.** `settleApprovalCard` rewrites the `messageBlocks` stored at post time, so styling
  added afterward is lost when the approval resolves.
- **DM delivery.** `deliverPrivateInteraction` calls `renderInteractionPostParts` directly, outside
  any renderer.

Restyling also tempts authors to put tool input beside the buttons. Slack echoes the whole
controls message back in every `block_actions` callback, which is why eve posts tool input as a
separate details message. In the issue's case, an inline nine-step plan made the echoed payload
about 26k characters.

`approval.prompt` customizes the prompt text but not structured blocks. The block helpers
(`renderInteractionBlocks`, `answerFromSlackAction`) leave batching, routing, authorization, and
settlement to the app.

Reading the settlement code turned up three more problems:

1. **Cards settle in two different places.** Approvals settle on `interaction.settled`, from the
   stored blocks. Questions settle in the click webhook (`updateAnsweredHitlCard`,
   `settleFreeformCard`), from the blocks Slack echoes back. The webhook has no session view, so
   it can't call a hook that takes an `Interaction`.
2. **Withdrawn questions appear to keep live buttons.** `recordApprovalCards` tracks only
   approvals, and `settleApproval` returns early for every other kind.
3. **Durable state holds every posted block.** `SlackPendingApprovalCard.messageBlocks` stores
   each block of every card message in `SlackChannelState`.

## Authoring API

```ts
/** One input request as eve is about to post or update it. */
export interface SlackInteractionCard {
  /** The request, read from the session: `status`, `outcome`, `answer`, `call` (with `input`). */
  readonly interaction: Interaction;
  /** Where eve posts it, as `approvalChannel` decided. */
  readonly destination: "thread" | "direct-message";
  /** Who reads it. Same meaning as `TaskCard.audience`. */
  readonly audience: ChannelAudience;
  /** The Slack user whose answer settled it, when known. */
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
default. The default returns what eve posts today: `renderInteractionPostParts` for an open
request, and for a settled one, the controls with their buttons replaced by the answer and who
gave it, as `answeredBlocksFromActionBlock` builds now.

The issue's sketch differs in three ways:

- **No separate `state` field.** `Interaction` already carries `status`, `outcome`, and `answer`.
- **No `null` return.** An open request with no controls can't be answered, and it would hold the
  turn. To keep a request out of the thread, use `approvalChannel`. To deliver it yourself, skip
  `next()` in `interaction.opened`.
- **`answeredBy` instead of a principal.** It's the Slack user ID, already resolved through
  `slackUsersByPrincipal`, so the hook doesn't need channel state.

## Semantics

```text
interaction.opened ─▶ route (approvalChannel) ─▶ interactionCard per request ─▶ check actions
                                                                      │
                     group details, then controls, under 50 blocks ◀──┘ ─▶ post, record ids

interaction.settled ─▶ interactionCard for every request in the message, from the current view
                     ─▶ check actions ─▶ chat.update controls; delete details when none are pending
```

- **Scope.** The hook runs for every interaction except sign-ins. That covers approvals,
  questions, and budget prompts, plus any kind a newer eve adds. Sign-ins carry a credential and
  keep their restricted delivery path.
- **What eve still owns.** Routing through `approvalChannel`, batching, posting, the 50-block
  grouping, `pendingApprovalCards`, encoding action IDs, `onAnswers` and approval response
  policies, the details message's lifecycle, and the DM announcement.
- **Actions on an open card.** `controls` must keep every interactive element that the default
  controls from `next()` contain, with the same `action_id` and the same `value` or options. A
  renderer can relabel elements, reorder them, or wrap them in blocks of its own.
- **Actions on a settled card.** `controls` must contain no eve action IDs.
- **Failures.** If the hook throws or breaks either rule above, eve logs the problem and uses its
  default for that interaction. A dropped approval would hold the turn, so a fallback beats
  posting nothing. `taskCard` handles a throwing renderer the same way.
- **Batching.** Each request renders on its own. eve then groups a batch's details messages, and
  then its controls messages, into as few messages as fit in 50 blocks each.
- **Settlement.** Every interaction except a sign-in settles on `interaction.settled`. eve renders
  every request in the message again from the current view, so requests that are still open keep
  their controls. It then sends one `chat.update`. If the settled message would exceed 50 blocks,
  eve uses its default settled rendering, one block per request, for that whole message.
  Withdrawn and answered questions retire the same way approvals do.
- **DM delivery.** The hook runs for requests that `approvalChannel` sends to a DM, with
  `destination: "direct-message"`.
- **No longer active.** A click after the session has gone runs in the webhook, where there's no
  view. That card keeps today's handling, which rewrites the blocks Slack echoed back.
- **Purity.** The hook is synchronous and makes no Slack calls.

## Boundaries

- `SlackPendingApprovalCard.messageBlocks` gives way to the message's interaction IDs, in order.
  eve records every interaction except sign-ins, not just approvals. eve is pre-1.0, so cards
  posted before the upgrade get no compatibility shim.
- Question and freeform cards now retire on `interaction.settled`, not in the click webhook. A
  question card updates a moment after the session commits the answer, as approvals already do.
- The composed `interactionCard` reaches eve's default `interaction.opened` and
  `interaction.settled` handlers the same way `withTaskCards` receives `rendering.taskCard`.
- Slack-only. No other channel has a renderer chain yet. `SlackInteractionCard` holds mostly
  channel-neutral data, so a later chain on another channel could reuse its shape.

## Alternatives

- **Restyle after `next()` in `interaction.opened`.** This is what the issue's author did, with
  the fragile coupling described above.
- **eve appends the controls, and the renderer returns only the blocks around them.** That's
  safer, but eve's approval controls are a single Slack `card` block with its buttons inside. A
  renderer couldn't restyle the card's title or body, which is the most likely customization.
  Checking the action IDs keeps that flexibility.
- **A channel-neutral hook on the shared interaction prompt layer.** Deferred until another
  channel has a renderer chain to host it.

## Validation

- A renderer that adds details for one tool still posts a two-approval batch as one details
  message and one controls message.
- Clicks on renderer-styled controls decode to the right interaction, and the interaction settles.
- The settled card uses the renderer's blocks, both for an answered approval and for one that is
  no longer needed.
- DM delivery uses the hook.
- A renderer that drops eve's controls, or keeps them on a settled card, falls back to the default.
- A withdrawn question loses its buttons.
- Docs: the Customize rendering and Human-in-the-loop sections of `docs/channels/slack.mdx`.
