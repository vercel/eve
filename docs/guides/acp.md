---
title: "Use eve through ACP"
description: "Use local or deployed eve agents from Agent Client Protocol clients."
---

Agent Client Protocol (ACP) clients can launch an authored eve application as a local subprocess. eve serves stable ACP v1 over stdio while its normal development server remains the execution runtime.

```sh
eve acp
```

Without a URL, the client starts one process from the eve application root. It supervises a local development server, and closing the ACP connection stops that owned server. To bridge ACP to a deployed eve agent, pass its URL:

```sh
eve acp https://agent.example.com
```

## Configure Zed

Open the eve application root as the Zed workspace. In **Agent Settings → External Agents**, add a custom agent:

```json
{
  "agent_servers": {
    "eve-local": {
      "type": "custom",
      "command": "pnpm",
      "args": ["exec", "eve", "acp"],
      "env": {}
    }
  }
}
```

Use an absolute command path if Zed cannot find `pnpm` in its environment. The workspace must be the same directory as the eve application root; eve rejects a different `session/new.cwd` instead of running the wrong application.

Disable Zed project MCP servers for this agent. The initial eve adapter does not accept client-provided MCP servers.

## Supported behavior

ACP clients receive:

- streamed assistant text and reasoning;
- tool-call requests and results;
- one-time tool approval and denial requests;
- fixed-choice and freeform questions when the client supports ACP form elicitation;
- cooperative turn cancellation;
- independent concurrent ACP sessions;
- session closure and process cleanup.

Development rebuilds retain normal eve semantics. In-flight work stays pinned to its generation, and the next turn uses the newest successful generation.

## Security and capability limits

ACP mode does not give the agent access to the editor's host filesystem or terminal. `session/new.cwd` identifies the eve application being launched; it is not mounted into the agent sandbox.

The initial adapter does not support:

- a deployed ACP HTTP or WebSocket endpoint;
- ACP authentication (remote bridges use the deployed eve agent's existing HTTP authentication);
- ACP v2;
- client filesystem or terminal methods;
- client-provided MCP servers;
- images, audio, files, or embedded resources in prompts;
- session loading, listing, resumption, or durable ACP IDs across process restarts;
- ACP model or mode configuration.

The agent continues to use the connections, tools, credentials, and sandbox policy authored in the eve application. Prompt text and ACP metadata never establish an authenticated end-user principal.

## Diagnose a connection

ACP reserves stdout for newline-delimited JSON-RPC. eve sends compilation output, server logs, and diagnostics to stderr so they cannot corrupt the protocol stream.

For a quick headless smoke test, run an ACP client such as `acpx` from the application root. `acpx` launches the ACP process itself; do not start `eve acp` separately.

```sh
npx acpx@latest \
  --agent 'pnpm exec eve acp' \
  exec 'Reply with exactly: ACP works'
```

When testing from the eve source checkout, use an authored fixture rather than the monorepo root, which does not provide an `eve` executable:

```sh
cd apps/fixtures/weather-agent
npx acpx@latest --agent 'pnpm exec eve acp' exec 'Reply with exactly: ACP works'
```

If startup fails, inspect the ACP client's logs together with eve's stderr. A non-empty client MCP configuration, a mismatched working directory, and unsupported prompt content produce explicit protocol errors before model work begins.
