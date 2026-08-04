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

This package is an experimental compatibility adapter for ordinary conversational replies. It is pinned to Buzz's current prompt framing and uses Buzz's triggering event ID for idempotency while preserving an optional thread reply anchor. It coordinates idempotent reply publication across local connector processes, including top-level DMs. If Buzz does not confirm whether a send was accepted, the adapter records an unknown delivery state and refuses automatic retries to avoid duplicate replies. It does not provide arbitrary Buzz actions, remote MCP, or interactive form elicitation.

## Why this adapter exists

Buzz currently expects an ACP agent to publish its own reply, while generic ACP agents stream assistant text back to the client. This adapter closes that gap by collecting eve's final assistant text and publishing it through the local Buzz CLI. It also projects eve's authored model as a fixed model because Buzz custom harnesses currently require client-managed model selection.

The adapter becomes unnecessary when Buzz:

1. Publishes streamed ACP assistant text through its existing signing and threading infrastructure.
2. Supports agent-managed models for custom ACP harnesses.
3. Provides conversation and reply context structurally instead of relying on prompt framing.

At that point, Buzz can launch `eve acp` directly. Buzz credentials, reply publication, and conversation routing can remain entirely inside Buzz.
