# Software factory — local agent references

Companion example for [`research/local-agents.md`](../../research/local-agents.md)
(proposed in [#2612](https://github.com/vercel/eve/pull/2612)).

> **Status: aspirational.** `defineLocalAgent` does not exist yet. This
> example does not build; it exists to make the proposed authoring
> experience concrete. It is excluded from the workspace and from the
> root typecheck.

## Layout

A workspace of peer agents. Foreman orchestrates; each task agent is a
complete top-level agent with its own instructions, tools, and dev loop:

```text
examples/factory/
  package.json                 imports map: "#agents/*" → "./agents/*"
  agents/
    foreman/agent/             orchestrator
      agent.ts
      instructions.md
      subagents/
        classifier.ts          defineLocalAgent → #agents/classifier
        reviewer.ts            defineLocalAgent → #agents/reviewer
    classifier/agent/          task agent: classify issues
      agent.ts
      instructions.md
    reviewer/agent/            task agent: review PRs; own tools
      agent.ts
      instructions.md
      tools/
        read_diff.ts
```

## What to look at

- `agents/foreman/agent/subagents/reviewer.ts` — the entire mount. An
  import (the address) plus a `description`. No config is carried: the
  reviewer's config, instructions, tools, and sandbox come from
  `agents/reviewer/`, compiled once for this deployment.
- `package.json#imports` — the one entry that makes `#agents/*` resolve.
  No per-agent `package.json` is needed.
- `agents/reviewer/` — a normal top-level agent. Run and eval it
  standalone; Foreman references the same directory. When deployed on
  its own it could declare `channels/`; those stay inert when it runs
  as Foreman's delegate.

## Semantics in one paragraph

The mount is an address, not a config carrier. Delegation dispatches to
the referenced agent in-process — the local counterpart of
`defineRemoteAgent`. The session that creates a delegation owns it, as
subagent sessions work today; the reference only selects which agent
graph defines the child's behavior. Swapping `reviewer.ts` to a
`defineRemoteAgent` mount moves the reviewer to its own deployment
without touching Foreman's delegation behavior.
