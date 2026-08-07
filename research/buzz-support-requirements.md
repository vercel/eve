---
issue: https://github.com/vercel/eve/issues/100
status: proposed
last_updated: "2026-07-29"
---

# Buzz support requirements

## Purpose

Define the boundary between eve's generic Agent Client Protocol (ACP) adapter and the platform-specific work required to run an eve agent as a visible Buzz participant.

## Existing comparison

Buzz launches Goose and `buzz-agent` as local ACP subprocesses:

```text
Buzz relay -> buzz-acp -> local ACP agent -> local Buzz CLI or MCP tool -> Buzz relay
```

ACP carries prompts, streamed output, tool activity, and turn lifecycle between `buzz-acp` and the agent. It does not publish a Buzz message by itself. Buzz's current base prompt therefore tells the agent to publish with `buzz messages send`.

This works for Goose because it runs on the Buzz host and can use the host's Buzz CLI and credentials. `buzz-agent` has a similar boundary: it is a generic ACP agent whose capabilities are supplied through local MCP servers such as `buzz-dev-mcp`. In both cases, the process that acts on the prompt can reach a Buzz-capable local tool environment.

An eve agent has an additional runtime boundary:

```text
Buzz relay -> buzz-acp -> eve acp -> eve HTTP runtime -> sandboxed tools
```

`eve acp` can receive the prompt and stream a complete ACP response, but the eve runtime does not implicitly inherit the local Buzz CLI, Nostr private key, or relay access. Buzz currently observes that ACP output but does not publish it as the chat reply.

## Why eve should expose generic ACP

`eve acp` must remain a platform-neutral ACP agent surface. This is the same composability principle used by `buzz-agent`: the agent protocol and platform tools are separate contracts.

A generic adapter:

- works with Zed and other ACP clients without Buzz-specific behavior;
- supports both local eve applications and deployed agents through the same interface;
- keeps ACP session, streaming, cancellation, tool, and human-input semantics in one tested implementation;
- avoids granting every eve runtime a Nostr identity merely because one ACP client is Buzz;
- leaves relay identity, signing, threading, retries, and delivery with the platform that owns them.

Therefore eve core must not parse Buzz prompt framing, sign Nostr events, invoke the Buzz CLI automatically, or treat ACP text as a Buzz message. It should continue to implement stable ACP and project eve behavior through its public `Client` and `ClientSession` APIs.

## Required outcome

A Buzz mention processed by an eve agent must result in one correctly signed and threaded Buzz reply, without requiring Buzz-specific behavior in eve's generic ACP adapter.

The component publishing the reply must own:

- the agent's Buzz/Nostr identity;
- the relay connection and authorization;
- the harness-selected channel and reply anchor;
- retry and idempotency behavior;
- reporting publication failure as a failed turn rather than successful completion.

## Support options

### Option A: Buzz-owned ACP reply sink — preferred

Change `buzz-acp` to accumulate the final ACP agent text and publish it using the harness's existing identity and routing context.

```text
buzz-acp -> eve acp -> final ACP text
    \-----------------> signed Buzz reply
```

This makes remote and sandboxed ACP agents behave like they do in Zed, where ACP text is the client-consumed answer. It also benefits ACP agents other than eve that cannot access host-local Buzz tools.

Requirements:

1. Publish only the final conversational response, not reasoning or intermediate tool text.
2. Use the harness-selected channel and thread/reply anchor.
3. Prevent duplicate replies when a dispatch or acknowledgement is retried.
4. Preserve the existing agent-owned publish path for agents that intentionally use Buzz tools, without double-posting.
5. Surface publication failures explicitly.

This is an upstream Buzz change, not an eve core change.

### Option B: external Buzz/eve connector — viable compatibility path

Run a local connector that speaks ACP to `buzz-acp`, calls a deployed eve agent, and publishes the final response with a locally held Nostr key.

The community `eve-acp-adapter.mjs` gist demonstrates this topology: it forwards prompts to eve's HTTP session API, reads the final response, signs a Nostr event locally, and posts it to Buzz. The private key remains outside the deployed eve runtime.

A supported connector should reuse `eve acp` or eve's public client rather than duplicate its protocol translation, and must add correct threading, cancellation, failure, and idempotency semantics missing from the proof of concept.

This option requires no eve core coupling, but leaves a Buzz-specific process to package and maintain.

### Option C: give the eve runtime Buzz tools and credentials — supported only as explicit app configuration

An authored eve application may define a Buzz-specific tool and provision relay credentials to its runtime. This follows the current Goose-style agent-owned publication model.

Requirements:

1. The application owner must opt in explicitly.
2. Credentials must use a dedicated least-privilege agent identity.
3. The tool must accept structured routing input rather than infer authorization from prompt prose.
4. Network, secret exposure, duplicate delivery, and prompt-injection risks must be documented.
5. No Buzz dependency or credential forwarding may be added to `eve acp` by default.

This enables richer Buzz actions, but couples the application to Buzz and moves signing authority into the model's tool boundary. It is not the default integration architecture.

## Additional compatibility

Buzz should support the stable ACP capabilities required by an eve turn. In particular, if an eve agent asks a supported structured question, `buzz-acp` must implement ACP form elicitation or return a clear unsupported-capability failure. ACP v2 system-prompt placement may improve integration later, but it does not solve reply publication and is not required for the reply sink.

## Decision

1. Keep `eve acp` generic and stable-ACP compliant.
2. Prefer an upstream `buzz-acp` reply sink for ordinary conversational replies.
3. Use an external connector if upstream support is unavailable.
4. Allow app-authored Buzz tools as an explicit advanced integration, never as implicit ACP behavior.

## Success criteria

- The same authored eve agent works in Zed and Buzz through `eve acp` without Buzz code in eve core.
- Buzz publishes exactly one signed reply with the correct identity and thread anchor.
- The Nostr private key remains in Buzz or a dedicated local connector unless an application explicitly opts into Buzz tools.
- ACP output, cancellation, and publication failures remain observable and are not reported as successful turns.
