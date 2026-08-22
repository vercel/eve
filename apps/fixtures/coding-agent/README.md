# Coding agent

This fixture delegates coding tasks to the flexible `harness_agent` tool. Its Vercel Sandbox
contains the public [`vercel/ms`](https://github.com/vercel/ms) TypeScript repository at
`/workspace/ms`.

The sandbox template clones the current `main` branch and installs its dependencies. When a new
durable eve session first uses the sandbox, the fixture runs `git pull --ff-only` and
`pnpm install --frozen-lockfile`. Changes then persist across turns in that session without another
pull overwriting them.

## How delegation works

The fixture exports `defineHarnessAgentTool()` from `agent/tools/harness_agent.ts`, so the outer
agent chooses the harness and may optionally choose its model. The instructions require every call
to pass `workingDirectory: "ms"`. That workspace-relative value resolves to `/workspace/ms`, where
the selected harness inspects, edits, and tests the repository.

Each invocation requires eve tool approval. After approval, the selected harness runs its built-in
tools without additional prompts. The sandbox exposes one bridge port, so the agent runs
bridge-backed harness calls sequentially.

See [HarnessAgent tool](../../../docs/concepts/built-in-tools.md#harnessagent-tool) for supported
harnesses, model overrides, and authentication behavior.

## Run locally

Link the fixture to a Vercel project before starting it. The linked project supplies the identity
and credentials needed to create Vercel Sandboxes and call models through Vercel AI Gateway.

```sh
cd apps/fixtures/coding-agent
pnpm exec eve link
pnpm dev
```

You can also set the model or provider credentials supported by your selected harness in the local
environment. For example, try this prompt after the TUI starts:

```text
Use Codex to add support for "fortnight" and "fortnights" to ms. Update the tests and documentation, then run the relevant checks.
```
