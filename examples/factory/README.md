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
station is a top-level agent, Foreman references them, and the
artifact-handoff tools every station duplicated become one shared
extension:

```text
examples/factory/
  package.json                     imports: #agents/* → ./agents/*, #lib/* → ./lib/*
  pnpm-workspace.yaml              packages/*
  lib/                             shared plumbing: models, github, trust, blob
  packages/
    artifacts/                     @factory/artifacts — handoff tools as an eve extension
      extension/
        extension.ts
        lib/                       self-contained: blob access scoped to artifacts/
        tools/
          save_artifact.ts
          read_artifact.ts
  agents/
    foreman/
      agent/
        agent.ts                   orchestrator config (unchanged)
        instructions.ts            the pipeline prompt (unchanged)
        channels/                  eve, github, linear — the factory's inbox
        extensions/
          github.ts                github tools (unchanged)
          artifacts/               @factory/artifacts, saver disabled
        tools/                     factory brain, user preferences
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
    researcher/agent/              station 1b (mounts artifacts, reader disabled)
    analyst/agent/                 station 2 (own sandbox; mounts full artifacts)
    implementer/agent/             station 3 (own sandbox + push tools; reader only)
    reviewer/agent/                station 4 (own sandbox, different model vendor; reader only)
```

Diff against the template, in full:

- `agent/subagents/<station>/` → `agents/<station>/agent/`, contents
  verbatim (config, instructions, tools, sandboxes).
- Five new mount files under `agents/foreman/agent/subagents/`, one call
  of substance each: `defineLocalAgent(station)`.
- `agent/lib/` → workspace-level `lib/`, imports normalized to `#lib/*`.
- The six per-agent copies of the artifact tools → one
  `@factory/artifacts` extension, mounted per agent with the same
  saver/reader split the template enforced by copy placement (see below).
- Tool names in instructions updated to the extension's composed names
  (`artifacts__save_artifact`, `artifacts__read_artifact`).
- One new eval, `agents/classifier/evals/classify-bug.eval.ts`,
  demonstrating the point: a station now has its own eval loop.

## Three kinds of sharing, three mechanisms

The workspace shares three different kinds of things, and each uses the
mechanism built for it:

| What is shared                                             | Mechanism                     | Here                                                                                                                                                     |
| ---------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model-visible capability (tools)                           | Extension                     | `@factory/artifacts`; the template's `@github-tools/eve-extension` mount, unchanged                                                                      |
| Code imported by authored modules                          | `lib/` + plain imports        | `models.ts`, github credential/git helpers, sandbox builders — extensions cannot declare sandboxes, so `repo-sandbox.ts` builders _must_ be library code |
| Agent identity (instructions, config, sandbox, delegation) | `defineLocalAgent` (proposed) | the five stations                                                                                                                                        |

The artifacts extension keeps the template's deliberate asymmetry, now
expressed as mount-level composition instead of copy placement: the
researcher mounts the saver only, the analyst both, the implementer,
reviewer, and Foreman the reader only (each disables the other tool
beside its mount with `disableTool()`). Foreman holding only the reader
is what keeps long documents flowing station-to-station instead of
through his context — the template's own design, preserved.

## Aren't these just subagents? (yes — that's the point)

Foreman's side of the relationship is unchanged: the stations appear to
him as subagents, lowered to delegation tools exactly like nested ones;
his pipeline evals still assert `t.calledSubagent("classifier")`
verbatim. There are no bidirectional references here, and none are
needed — the pipeline is a straight line.

What changes is the stations' side. A nested subagent directory is
_only_ a subagent: no entry point of its own, no evals without the
parent, no channels ever (the grammar forbids them), unreachable by a
second orchestrator. The reference makes the station a complete agent
that _also_ serves as a subagent:

- `agents/classifier/evals/` runs against the classifier directly — the
  template could only eval stations through Foreman's pipeline.
- Each station is deployable standalone tomorrow: swap the mount file to
  `defineRemoteAgent` and Foreman's delegation behavior is unchanged.
- A reviewer deployed standalone could declare `channels/` (a webhook
  aimed directly at review); inert while it runs as Foreman's delegate.

So the mount answers "how does Foreman see it" (a subagent, as today) and
the reference answers "what is it" (an agent). Bidirectional references
are legal under the proposal's semantics — useful when two orchestrators
delegate to each other — but this example doesn't need them, and that's
representative: most workspaces are DAGs.

## What to look at

- `agents/foreman/agent/subagents/reviewer.ts` — the entire feature
  surface. The station's `description` and `outputSchema` are authored in
  its own `agent.ts` (where the template already put them), so the mount
  is just the reference.
- `packages/artifacts/` + any station's `extensions/artifacts/` mount —
  the capability-sharing pattern: one package, per-agent composition.
- `agents/reviewer/agent/sandbox.ts` — unchanged from the template. The
  isolation the template documents ("declared subagents share nothing
  with the root or each other") is preserved: references don't change
  sandbox ownership.
- `agents/classifier/evals/` vs `agents/foreman/evals/` — station-level
  evals against the classifier directly; pipeline and safety evals stay
  with the orchestrator, where the pipeline lives.

[template]: https://github.com/vercel-labs/eve-software-factory-template
[blog]: https://vercel.com/blog/building-a-software-factory-for-ai-sdk
