# Software factory — local agent references

The [eve software factory template][template] (Foreman and its four
stations, the system behind [`ai-sdk-factory`][blog]), restructured as a
workspace of peer agents composed with `defineLocalAgent`.

> **Status: aspirational.** `defineLocalAgent` is proposed in
> [`research/local-agents.md`](../../research/local-agents.md)
> ([#2612](https://github.com/vercel/eve/pull/2612)) and does not exist
> yet. Everything else in this example is the real template's code. The
> example is excluded from the workspace and the root typecheck.

## What changed against the template

The template is one eve app: Foreman is the root, and every station lives
under `agent/subagents/<station>/`, reachable only through him. Here each
station is a top-level agent, and Foreman references them:

```text
examples/factory/
  package.json                     imports: #agents/* → ./agents/*, #lib/* → ./lib/*
  lib/                             shared: models, github, artifacts, trust, blob
  agents/
    foreman/
      agent/
        agent.ts                   orchestrator config (unchanged)
        instructions.ts            the pipeline prompt (unchanged)
        channels/                  eve, github, linear — the factory's inbox
        extensions/github.ts       github tools
        tools/                     factory brain, user preferences, artifacts
        subagents/
          classifier.ts            defineLocalAgent → #agents/classifier
          researcher.ts            defineLocalAgent → #agents/researcher
          analyst.ts               defineLocalAgent → #agents/analyst
          implementer.ts           defineLocalAgent → #agents/implementer
          reviewer.ts              defineLocalAgent → #agents/reviewer
      evals/                       pipeline + safety evals (unchanged)
    classifier/
      agent/                       station 1, verbatim from the template
      evals/classify-bug.eval.ts   NEW: evals the station directly, no Foreman
    researcher/agent/              station 1b
    analyst/agent/                 station 2 (own sandbox: repo checkout)
    implementer/agent/             station 3 (own sandbox + push tools)
    reviewer/agent/                station 4 (own sandbox, different model vendor)
```

Diff against the template, in full:

- `agent/subagents/<station>/` → `agents/<station>/agent/`, contents
  verbatim (config, instructions, tools, sandboxes).
- Five new mount files under `agents/foreman/agent/subagents/`, one line
  of substance each: `defineLocalAgent(station)`.
- `agent/lib/` → workspace-level `lib/`, imports normalized to `#lib/*`
  (the template already used `#lib/*` for root tools; stations used
  relative paths because they had to).
- One new eval, `agents/classifier/evals/classify-bug.eval.ts`,
  demonstrating the point: a station now has its own eval loop.

## What to look at

- `agents/foreman/agent/subagents/reviewer.ts` — the entire feature
  surface. The station's `description` and `outputSchema` are authored in
  its own `agent.ts` (where the template already put them), so the mount
  is just the reference.
- `agents/reviewer/agent/sandbox.ts` — unchanged from the template. The
  isolation the template documents ("declared subagents share nothing
  with the root or each other") is preserved: references don't change
  sandbox ownership, and the reviewer still fetches the branch under
  review into its own checkout.
- `agents/classifier/evals/` vs `agents/foreman/evals/` — station-level
  evals against the classifier directly; pipeline and safety evals stay
  with the orchestrator, where the pipeline lives.

## Why this shape

The factory's design principle is one agent per task, each with its own
prompts, context, and evals. As nested subagents the stations have no
standalone entry point, cannot be evaled without Foreman, and cannot be
reused by a second orchestrator. As peers, each station gets its own dev
loop today and its own deployment tomorrow: swap a mount file to
`defineRemoteAgent` and Foreman's delegation behavior is unchanged.

Session semantics stay as the template documents them: Foreman's session
creates and owns each delegation; the reference selects which agent graph
defines the child's behavior.

[template]: https://github.com/vercel-labs/eve-software-factory-template
[blog]: https://vercel.com/blog/building-a-software-factory-for-ai-sdk
