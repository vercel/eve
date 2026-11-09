---
issue: "TBD (maintainer-requested research; prototype in https://github.com/vercel/eve/pull/6112)"
status: proposed
last_updated: "2026-11-06"
---

# Extensible reply content

> **AI status:** Written entirely by AI; human review pending.

## Problem

Agents can only reply with text. Richer replies, such as a [json-render](https://json-render.dev)
card with a table and a chart, need three things the framework doesn't offer:

1. A tool can't contribute to the reply. Its call is activity, so a card drawn by a tool is
   rendered as a tool call, replaced in the turn's answer by later text, and invisible to
   channels that don't know the tool.
2. Built-in channels drop every reply part that isn't text, even when it carries `fallbackText`.
3. An extension can't change how the agent's channels render. Only Slack composes renderers, and
   the agent's channel file has to list them.

The [json-render Slack prototype](https://github.com/vercel/eve/pull/6112) works around all
three with a tool, a Slack renderer that parses the tool's streaming input, and manual wiring.

`ask_question` shows the shape this should take. It's a thin tool over a core primitive
(`ctx.ask()` and interactions) that every channel renders natively. This plan adds the
matching primitives for output.

## Goals

- Tools can add parts to the turn's reply, streamed while the model writes them.
- Every channel and client shows a reply part it doesn't understand through its fallback text.
- Extensions contribute renderers for a media type, and channels use them natively.

Card-specific code stays out of core. json-render ships as an extension.

## Primitives

| Primitive         | Core owns                                                         | Extensions add                  |
| ----------------- | ----------------------------------------------------------------- | ------------------------------- |
| Tool reply parts  | Streaming, completion, reply semantics, fallback text for readers | Cards, charts, galleries        |
| Text fallback     | Showing any part through its fallback text in every reader        | Nothing; it's the floor         |
| Content renderers | Discovery, precedence, channel delivery, edits while streaming    | Native rendering per media type |

### 1. Tool reply parts

A tool declares `replyPart` to add a part to the turn's reply when a call succeeds:

```ts title="agent/tools/card.ts"
import { defineTool } from "eve/tools";

export default defineTool({
  description: "Show structured data as a card.",
  inputSchema: cardSpecSchema,
  replyPart: {
    kind: "card",
    mediaType: "application/vnd.json-render+json",
    // Stream the call's input as the part's preview while the model writes it.
    streamInput: true,
    // After the call succeeds: the part's value and fallback text, or null for no part.
    // A throw fails the call; the model reads why and can retry.
    build: (input, output) => ({ value: toCardValue(input), fallbackText: cardText(input) }),
  },
  async execute() {
    return { shown: true };
  },
});
```

On the session stream:

```
call.input?                     ← not emitted for a streaming reply tool
content.delta  { partId, kind: "card", callId, delta }   ← input JSON as the model writes it
call.requested / call.started
  … execute …
content.completed { partId, kind: "card", callId, phase: "reply",
                    value, mediaType, fallbackText }      ← same commit as call.settled
call.settled   { outcome: "completed" }
```

- `content.delta` and `content.completed` gain an optional `callId`: the call that wrote the
  part. The part belongs to the call's turn, not its model run, so it completes after the run
  settles.
- A preview with a `callId` lives until its call settles, like a call's own input preview. A
  failed or rejected call drops it without completing the part.
- A part written by a call joins its turn's reply and is never replaced by a later step's
  reply. Today a later step's reply replaces an earlier one's, so a card followed by "Here's
  last week's summary" would lose the card from `turn.reply`.
- `fallbackText` is required for any kind other than `text`. Readers that only show text use
  it: channels without a renderer, ACP, the dev TUI, and eval reply assertions. A subagent's
  answer stays the text its model wrote.
- The model sees the tool's ordinary result. `toModelOutput` still applies.
- A tool with a reply part has no side effects. A throw from `build` fails the call after
  `execute` ran, and the model's retry runs it again.
- With `endsTurn: true`, the part is the whole answer and the turn ends without another model
  call.

### 2. Text fallback everywhere

A reply part of a kind a reader doesn't render is shown through its `fallbackText`:

- `channel/surface.ts` (Teams, Discord, Telegram, Twilio, GitHub), Slack, Chat SDK, and Linear
  post it as reply text.
- The client message projection adds a generic part for React, Vue, and Svelte, so apps can
  render it or fall back:

  ```ts
  interface EveContentPart {
    readonly type: "content";
    readonly kind: string;
    readonly mediaType?: string;
    readonly text?: string; // The raw preview while streaming.
    readonly value?: unknown; // Once done.
    readonly fallbackText?: string;
    readonly callId?: string;
    readonly state: "streaming" | "done";
  }
  ```

- The dev TUI prints the fallback text.

Nothing else changes for text parts.

### 3. Content renderers

A file under `agent/renderers/` or `extension/renderers/` renders one media type in every
channel that supports rich messages:

```ts title="extension/renderers/card.ts"
import { defineContentRenderer } from "eve/renderers";

export default defineContentRenderer({
  mediaType: "application/vnd.json-render+json",
  // A card for channels with rich messages, or null to fall back. While the part streams, eve
  // repairs the partial JSON of a `+json` media type and passes it with `partial: true`. The
  // stream and `EveContentPart.text` keep the raw preview.
  card(value, { partial }) {
    return partial ? toPartialCard(value) : toCard(value);
  },
  // Optional: markdown for GitHub, Linear, and the TUI.
  markdown(value) {
    return cardMarkdown(value);
  },
});
```

- Cards use eve's card element types, which `eve/channels/slack` already exports and which
  move to `eve/cards`. They are Chat SDK's card format under eve-owned types.
- Slack and the Chat SDK channel render cards natively: they post on the first renderable
  preview, edit as it streams, and replace the message with the completed part. GitHub and
  Linear use `markdown`. Every other channel, and any renderer that returns `null` or throws,
  falls back to `fallbackText`. Native Teams and Discord cards follow this plan.
- The file name supplies the renderer's name. A renderer in the agent wins over an extension's
  for the same media type; two extensions claiming one media type is a build error naming both.
  There is no way to turn a media type's rendering off in favor of its fallback text.
- Channel-specific overrides stay where they are: a Slack renderer's `content.completed`
  handler still sees every part first.

## json-render as an extension

`@eve/json-render` contributes the `card` tool with `replyPart`, a renderer for
`application/vnd.json-render+json`, and instructions. It vendors `@json-render/core` and
`@json-render/chat`, which are pre-1.0, so their API never becomes eve's. Mounting it is the
only setup:

```ts title="agent/extensions/cards.ts"
export { default } from "@eve/json-render";
```

## Non-goals

- Custom component catalogs. Channels render natively, so a card can only use components every
  channel understands. Web apps that need custom components can use json-render directly.
- Interactive cards. Nothing on a card round-trips to the agent, so a card's catalog offers link
  buttons but not action buttons.
- Questions with rich bodies, and a public mark for tools that act only on the conversation.
  Those extend `ctx.ask()` and interactions, and belong in a plan of their own.
- A web card component in core. The client exposes the part; a renderer for React belongs in the
  docs registry beside the web chat components.

## Rollout

Each primitive is additive and ships on its own:

1. Tool reply parts: protocol fields, harness, and fold.
2. Text fallback in channels, clients, and the TUI.
3. Content renderers and `eve/cards`, with Slack and Chat SDK.
4. `@eve/json-render`, replacing the example's manual wiring.

## Decisions

- The tool field is `replyPart`, not `reply`, so it doesn't read as the `eve__reply` tool that
  structured output uses. Its function is `build`.
- Renderers get the partial JSON of a `+json` part already parsed. The stream and clients keep
  the raw preview text.
- A subagent's answer stays the text its model wrote, without its reply parts' fallback text.
- Native Teams and Discord cards follow this plan; until then, both show fallback text.

## Follow-ups

- Native Teams cards (eve cards to Adaptive Cards) and Discord embeds.
- Turning off a media type's renderer in favor of its fallback text, if agents need it.
- Interactions: a content body on `ctx.ask()` whose buttons answer the question, and a public
  `conversational: true` mark so tools like `ask_question` aren't gated by the agent's approval
  policy. With both, `ask_question` could ship as an extension.
