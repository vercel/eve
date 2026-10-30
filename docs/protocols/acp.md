---
title: "Editor Integration (ACP)"
description: "Use local or deployed eve agents from Agent Client Protocol clients."
---

`eve acp` lets Agent Client Protocol (ACP) clients, such as editors, run an eve application as a local subprocess. eve serves stable ACP v1 over stdio, and its development server runs the agent.

```sh
eve acp
```

Without a URL, the client starts one `eve acp` process from the eve application root. That process runs a local development server until the ACP connection closes. To connect ACP to a deployed eve agent, pass its URL:

```sh
eve acp --url https://agent.example.com
```

For a recognized Vercel deployment, eve verifies the exact origin and gets a short-lived OIDC token for that project from the local Vercel session. Remote access requires an existing authorized Vercel session; account login runs during local deployment. Configure any required Trusted Sources access in the target project before launching ACP. For a deployment with a Protection Bypass for Automation token, set `VERCEL_AUTOMATION_BYPASS_SECRET`.

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

Disable Zed project MCP servers for this agent, because eve doesn't accept client-provided MCP servers.

## Supported behavior

ACP clients receive:

- streamed assistant text and reasoning;
- tool-call requests and results;
- one-time tool approval and denial requests;
- fixed-choice and freeform questions when the client supports ACP form elicitation;
- cooperative turn cancellation;
- independent concurrent ACP sessions;
- session closure and process cleanup.

When the development server rebuilds, work already running finishes on its original build. The next turn uses the newest successful build.

## Security and capability limits

ACP mode gives the agent no access to the editor's host filesystem or terminal. `session/new.cwd` identifies the eve application being launched and isn't mounted into the agent sandbox.

eve's ACP adapter doesn't support:

- a deployed ACP HTTP or WebSocket endpoint;
- ACP authentication (a remote connection uses the deployed eve agent's existing HTTP authentication);
- ACP v2;
- client filesystem or terminal methods;
- client-provided MCP servers;
- images, audio, files, or embedded resources in prompts;
- session loading, listing, or resumption, or ACP IDs that survive process restarts;
- ACP model or mode configuration.

The agent continues to use the connections, tools, credentials, and sandbox policy authored in the eve application. Prompt text and ACP metadata never authenticate an end user.

## Diagnose a connection

ACP reserves stdout for newline-delimited JSON-RPC, so eve sends compilation output, server logs, and diagnostics to stderr.

For a headless smoke test, run an ACP client such as `acpx` from the application root. `acpx` launches the ACP process itself, so don't start `eve acp` separately.

```sh
npx acpx@latest \
  --agent 'pnpm exec eve acp' \
  exec 'Reply with exactly: ACP works'
```

In the eve source checkout, test from an authored fixture, because the monorepo root has no `eve` executable:

```sh
cd apps/fixtures/weather-agent
npx acpx@latest --agent 'pnpm exec eve acp' exec 'Reply with exactly: ACP works'
```

If startup fails, inspect the ACP client's logs together with eve's stderr. A non-empty client MCP configuration, a mismatched working directory, and unsupported prompt content produce explicit protocol errors before model work begins.
