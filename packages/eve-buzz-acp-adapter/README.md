# @eve/buzz-acp-adapter

Experimental Buzz ACP compatibility adapter for [`eve`](https://eve.dev) agents.

```text
buzz-acp -> eve-buzz-acp-adapter -> eve acp -> eve runtime
                  |
                  +-> local buzz CLI -> Buzz reply
```

## Install

```sh
npm install --global @eve/buzz-acp-adapter
eve-buzz-acp-adapter install
```

The interactive installer asks whether the eve application is local or deployed, validates the selected target, discovers its authored model, locates Buzz Desktop, and confirms before writing the custom harness. For a protected Vercel deployment, it reuses eve's Vercel login and Trusted Sources flow; the harness stores no Vercel credential.

The installed harness requires the Buzz agent's **Respond to** setting to remain **Owner only**. Buzz verifies inbound Nostr events and applies that author gate before sending a prompt to the adapter. In Buzz, owner-only includes the agent's owner and cryptographically verified sibling agents belonging to that owner. The adapter fails before starting eve if Buzz reports another mode or does not expose the mode.

A positional target may be a working directory or URL. Deployed hostnames without a protocol default to HTTPS:

```sh
eve-buzz-acp-adapter install ./path/to/eve-app
eve-buzz-acp-adapter install agent.example.com
```

For scripts and CI, use explicit target flags and confirmation:

```sh
eve-buzz-acp-adapter install --local ./path/to/eve-app --yes
eve-buzz-acp-adapter install --url https://agent.example.com --yes
```

A service agent intentionally shared with multiple people can opt into Buzz's **Allowlist** or **Anyone** modes during installation:

```sh
eve-buzz-acp-adapter install --url https://agent.example.com --allow-shared-principal --yes
```

This is an authorization decision, not a compatibility flag. It records `EVE_BUZZ_ALLOW_SHARED_PRINCIPAL=1` in Buzz's machine-wide custom harness definition for eve. Every Buzz agent using that harness can then use a broader author gate, and every sender accepted by Buzz uses the same eve authentication, connections, tools, and session state. Reinstall without the flag to restore the owner-only requirement.

Reopen Buzz, create or edit an agent, and select **eve** as its harness. Use the harness defaults, save the agent, and start it. The connector launches `eve acp`; do not start a separate ACP process.

To inspect the selected target before installation:

```sh
eve-buzz-acp-adapter doctor ./path/to/eve-app
```

## Develop locally

From the eve repository:

```sh
pnpm --filter eve build
pnpm --filter @eve/buzz-acp-adapter build
node packages/eve-buzz-acp-adapter/dist/cli.js install apps/fixtures/weather-agent
```

Without a target, the installer defaults the local-directory prompt to the current directory.

## Direct use

```sh
eve-buzz-acp-adapter                         # local application in the current directory
eve-buzz-acp-adapter https://agent.example.com
```

Buzz Desktop sets `BUZZ_ACP_RESPOND_TO` when it launches its harness. A custom launcher must set that variable to `owner-only` or `nobody`. For an intentional shared-principal deployment, pass `--allow-shared-principal` or set `EVE_BUZZ_ALLOW_SHARED_PRINCIPAL=1` in the adapter process. Do not set the opt-in in the eve application runtime itself; it is connector policy and the adapter removes it before launching `eve acp`.

This package is an experimental compatibility adapter for ordinary conversational replies. It is pinned to Buzz's current prompt framing and uses Buzz's triggering event ID for idempotency while preserving an optional thread reply anchor. It coordinates idempotent reply publication across local connector processes, including top-level DMs. If Buzz does not confirm whether a send was accepted, the adapter records an unknown delivery state and refuses automatic retries to avoid duplicate replies. It does not provide arbitrary Buzz actions, remote MCP, or interactive form elicitation.

## Security and sender identity

Buzz and eve authenticate different actors at different boundaries:

- Buzz verifies the signed inbound event and decides whether its author may trigger the agent.
- The adapter trusts Buzz's local ACP process boundary, but ACP supplies the event and its `From:` line as prompt text rather than authenticated sender metadata.
- `eve acp` authenticates the local or deployed eve target using the credentials configured for the harness. It does not turn the Buzz sender into `ctx.session.auth.current`.

The adapter therefore never treats `From:`, an event ID, ACP metadata, or any other prompt text as an eve principal. Parsing that text into authentication would let prose control an authorization boundary and would violate eve's ACP security model. Buzz's verified sender identity stops at the author gate.

### Owner-only default

Owner-only limits use of the shared eve capability to the Buzz agent's ownership domain. The owner and same-owner sibling agents can trigger turns; other channel members cannot trigger a turn even though their messages may appear in channel or conversation context. This is containment, not per-sender delegation: accepted triggers still run with the same eve identity and authored capabilities.

The adapter checks `BUZZ_ACP_RESPOND_TO` before spawning eve. It accepts `owner-only` and the inert `nobody` mode. It rejects `allowlist`, `anyone`, malformed values, and a missing value unless shared-principal mode was explicitly enabled. This check supplements Buzz's author gate; it does not reverify Nostr signatures.

### Shared-principal opt-in

With `--allow-shared-principal`, the adapter permits any author gate Buzz accepts. Use it only for an agent deliberately designed as a shared service:

- provision dedicated, least-privilege app credentials instead of personal credentials;
- assume every allowlisted or eligible channel participant can exercise every capability exposed to the agent;
- keep approval policies and destructive-operation controls appropriate for the least-trusted accepted sender;
- remember that Buzz uses one ACP session per channel, so conversation state is shared at the channel boundary;
- use separate eve targets and separately installed Buzz harnesses when groups require different credentials or trust boundaries.

User-scoped eve connections cannot map to a Buzz sender through this adapter. If target authentication establishes the connector operator as an eve user, every accepted Buzz sender acts as that same eve user and can reach that user's connections. If the target establishes only a service, runtime, or anonymous principal, user-scoped connections fail authorization; app-scoped connections remain shared. Do not interpret a name or Nostr public key visible to the model as proof that eve authenticated that person.

True per-sender authentication requires two protocol changes: Buzz must expose the signature-verified sender as structured authenticated data, and eve ACP must provide an explicit trusted per-turn principal handoff. Until both exist, the adapter intentionally offers only owner-domain containment or an explicit shared-service model.

## Why this adapter exists

Buzz currently expects an ACP agent to publish its own reply, while generic ACP agents stream assistant text back to the client. This adapter closes that gap by collecting eve's final assistant text and publishing it through the local Buzz CLI. It also projects eve's authored model as a fixed model because Buzz custom harnesses currently require client-managed model selection.

The adapter becomes unnecessary when Buzz:

1. Publishes streamed ACP assistant text through its existing signing and threading infrastructure.
2. Supports agent-managed models for custom ACP harnesses.
3. Provides conversation and reply context structurally instead of relying on prompt framing.

At that point, Buzz can launch `eve acp` directly. Buzz credentials, reply publication, and conversation routing can remain entirely inside Buzz.
