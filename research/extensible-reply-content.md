---
issue: "TBD (maintainer-requested research; prototype in https://github.com/vercel/eve/pull/6112)"
status: proposed
last_updated: "2026-11-06"
---

# Extensible reply content and interactions

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
matching primitives for output, and opens interactions enough that `ask_question`, and cards
with buttons, could ship as extensions.

## Goals

- Tools can add parts to the turn's reply, streamed while the model writes them.
- Every channel and client shows a reply part it doesn't understand through its fallback text.
- Extensions contribute renderers for a media type, and channels use them natively.
- Extensions can ask richer questions, with a content body whose buttons are the answers.

Card-specific code stays out of core. json-render ships as an extension.

## Primitives

| Primitive                                   | Direction | Core owns                                                         | Extensions add                     |
| ------------------------------------------- | --------- | ----------------------------------------------------------------- | ---------------------------------- |
| Tool reply parts                            | Output    | Streaming, completion, reply semantics, fallback text for readers | Cards, charts, galleries           |
| Content renderers                           | Output    | Discovery, precedence, channel delivery, edits while streaming    | Native rendering per media type    |
| Interaction bodies and conversational tools | Input     | Asking, durable waits, answer routing and authorization           | `ask_question`, cards with buttons |

### 1. Tool reply parts

A tool declares `reply` to add a part to the turn's reply when a call succeeds:

```ts title="agent/tools/card.ts"
import { defineTool } from "eve/tools";

export default defineTool({
  description: "Show structured data as a card.",
  inputSchema: cardSpecSchema,
  reply: {
    kind: "card",
    mediaType: "application/vnd.json-render+json",
    // Stream the call's input as the part's preview while the model writes it.
    streamInput: true,
    // After the call succeeds: the part's value and fallback text, or null for no part.
    part: (input, output) => ({ value: input, fallbackText: cardText(input) }),
  },
  async execute(spec) {
    validateCard(spec); // Throwing fails the call; the model reads why and can retry.
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
  // A card for channels with rich messages, or null to fall back. While the part streams,
  // `value` is the partially parsed JSON and `partial` is true.
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
  preview, edit as it streams, and replace the message with the completed part. Teams and
  Discord render cards once they convert eve cards to Adaptive Cards and embeds. GitHub and
  Linear use `markdown`. Every other channel, and any renderer that returns `null` or throws,
  falls back to `fallbackText`.
- The file name supplies the renderer's name. A renderer in the agent wins over an extension's
  for the same media type; two extensions claiming one media type is a build error naming both.
- Channel-specific overrides stay where they are: a Slack renderer's `content.completed`
  handler still sees every part first.

### 4. Interaction bodies and conversational tools

`ctx.ask()` accepts a content body, rendered with the same renderers, and a card's buttons can
be the question's options:

```ts
const answer = await ctx.ask({
  prompt: "Ship this release?",
  body: { mediaType: "application/vnd.json-render+json", value: spec, fallbackText },
  options: [
    { id: "ship", label: "Ship" },
    { id: "hold", label: "Hold" },
  ],
});
```

- `interaction.opened` carries the body on its request. Readers that can't render it show its
  fallback text above the prompt, so older clients still work.
- A renderer that draws the options inside the body (a card's Button elements) marks the body
  as owning them, and the channel skips its own option buttons. A press routes through the
  existing answer path, with its checks on who may answer.
- `defineTool` gains `conversational: true` for tools that act only on the conversation: they
  aren't gated by the agent's approval policy, so a person is never asked to approve being
  asked. Built-in `ask_question`, `sleep`, and `no_reply` use the same mark today, privately.

With these, `ask_question` is about 130 lines on public APIs, and an extension can provide it.
`eve/tools/ask_question` stays as a stable export.

## json-render as an extension

`@eve/json-render` contributes the `card` tool with `reply`, a renderer for
`application/vnd.json-render+json`, and instructions. It vendors `@json-render/core` and
`@json-render/chat`, which are pre-1.0, so their API never becomes eve's. Mounting it is the
only setup:

```ts title="agent/extensions/cards.ts"
export { default } from "@eve/json-render";
```

## Non-goals

- Custom component catalogs. Channels render natively, so a card can only use components every
  channel understands. Web apps that need custom components can use json-render directly.
- Interactive cards with state or forms. Buttons answer questions; nothing else round-trips.
- A web card component in core. The client exposes the part; a renderer for React belongs in the
  docs registry beside the web chat components.

## Rollout

Each primitive is additive and ships on its own:

1. Tool reply parts: protocol fields, harness, and fold.
2. Text fallback in channels, clients, and the TUI.
3. Content renderers and `eve/cards`, with Slack and Chat SDK.
4. Interaction bodies and `conversational`.
5. `@eve/json-render`, replacing the example's manual wiring.

## Open questions

- `reply` as the tool field name, beside the `eve__reply` tool that structured output uses.
- Whether previews of `+json` media types should reach renderers already parsed, or as text.
- Whether a subagent's answer should include its reply parts' fallback text.
- Whether Teams and Discord card support belongs in this plan or follows it.
