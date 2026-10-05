# Friction signals

`scripts/sweep.sh` is the source of truth for the searches: it runs every
command listed below and groups the hits by class. The one exception is the
S1 import inventory, which `scripts/subject.sh` prints. This file explains
what each class means and what to look for when you open a hit. A hit is a
candidate, not a finding: open the file.

Commands assume the project root and an `agent/` directory; set
`EVE_AGENT_DIR` when the layout differs. Quote `--include` patterns in zsh.

## S0. Every comment that mentions eve

Search:

```sh
grep -rnE "^\s*(//|\*|/\*\*?|#|-)\s*.*\b[Ee]ve\b" agent docs --include='*.ts' --include='*.md' | grep -viE "import|export|from ['\"]eve"
```

Means: the project explained itself. This is the highest-yield signal and the
one most often skimmed. Read every line. A comment that states an eve behavior
("Eve does not inherit root hooks", "Eve 0.63's reasoning enum stops at
xhigh", "Vercel cron is UTC", "eve's cross-project matcher intentionally
rejects them") is a candidate on its own, even when the file already produced
a record for something else. Do not require the comment to contain a
complaint word; the keyword searches in S8 are a subset of this.

Area: any.

## S1. Internal imports and type reach-ins

Search:

```sh
grep -rnE "from ['\"]eve/(dist|src|internal)" agent tests scripts
grep -rhoE "from ['\"]eve(/[^'\"]*)?['\"]" agent tests scripts | sort | uniq -c | sort -rn
grep -rnE "as unknown as|as any\b" agent | grep -iE "eve|channel|session|state|ctx"
grep -rnE "\.adapter\b|\.adapter\?\.\[|Runtime[A-Z][A-Za-z]*Channel|__eve|Symbol\.for\(['\"]eve" agent
```

Means: eve does not expose the state or hook the project needs. Compare each
specifier against `exports` in `node_modules/eve/package.json`. Casting into
eve's channel or session state types to store project data is the same gap.
A project can have zero internal imports and still reach in at runtime:
`channel.adapter["message.completed"]`, a `Proxy` over `ctx.thread.post`, or
a locally declared `RuntimeChannel` type that mirrors eve internals. Those
usually come with a boot-time throw ("installed eve adapter is incompatible");
grep for that phrasing too.

Area: public API surface, channel/session state.

## S2. Wrapping and patching eve objects

Search:

```sh
grep -rnE "^export (async )?function with[A-Z]|= with[A-Z][A-Za-z]+\(" agent
grep -rnE "Object\.assign\(.*(channel|adapter|tool)|\.(onEvent|onAppMention|onDirectMessage|onInteraction|onSlashCommand) = " agent
grep -rnE "guard[A-Z][A-Za-z]*\(|intercept|monkey" agent
```

Means: composition over a channel, route, or tool that eve does not offer as a
middleware or option. Record what the wrapper adds: dedup, ownership, auth,
logging, presentation.

Area: channel composition, HITL ownership, ingress.

## S3. Parallel liveness and delivery infrastructure

Search:

```sh
ls agent/schedules
grep -rnE "waitUntil|setInterval|setTimeout\([^,]+, *[0-9]{4,}" agent
grep -rniE "keepalive|heartbeat|watchdog|supervis|sweep|reaper|outbox|stall|reconcil" agent --include='*.ts' -l
grep -rnE "for \(;;\)|while \(true\)|while \(!" agent
grep -rnE "\.stream\(|/stream\b|EventSource" agent
```

Means: the project waits, polls, or re-delivers on eve's behalf. Classify each:
durable wait (callback, hook resume, workflow `sleep`) is fine; cron over the
project's own table with leases is eve's documented fallback; a held-open
function, a stream read from a handler, or a cron that probes other systems
is a workaround. Ask what eve signal it is substituting for.

Area: background tasks, subagent completion, task deadlines, delivery policy,
Slack status, cross-process dedup.

## S4. Re-implemented framework concerns

Search by name, then confirm by reading:

```sh
ls agent/lib | grep -iE "dedup|ownership|authority|owner|approval|guard|budget|limit|retry|outbox|coordinator|presentation|markdown|progress|routing|router|failover|model|credential|identity|session|dispatch|delivery|thread"
grep -rnE "defineTool|export default" agent/tools | grep -iE "sleep|agent|ask_question|task|status|cancel"
```

Means: the project owns something eve also owns. Check whether eve ships it
(`eve/tools/*` export map, `node_modules/eve/docs`) and whether the project's
version exists because eve's was missing, too rigid, or buggy at the pin.
A project-authored `sleep`, `agent`, or `ask_question` tool next to the eve
export of the same name is always a record.

Area: HITL and approvals, Slack rendering, model routing and failover, budgets,
tool library.

## S5. Protocol in the prompt

Search:

```sh
wc -c agent/instructions.md agent/subagents/*/instructions.md
grep -niE "wait for|do not end|never end|before ending|tool result|receipt|background|task state|confirmation id|acknowledg" agent/instructions.md agent/skills/*.md agent/subagents/*/instructions.md
grep -rnE "description:.*\b(then|after|first|step [0-9]|call .* again|return .* id)" agent/subagents agent/tools
```

Means: the prompt encodes runtime mechanics because eve gives the model no
structured way to do it, or the prompt was written for an older eve behavior.
Compare each instruction with what the harness injects for the pinned version
(search `node_modules/eve/dist` for the instruction text; docs under
`node_modules/eve/docs/subagents` and `node_modules/eve/docs/tools`).
Contradictions are always gaps: the model receives both.

Area: task delivery instructions, subagent contract, HITL.

## S6. Contract tests and verification against eve

Search:

```sh
grep -nE "postbuild|verify|reconcile|prebuild" package.json
ls scripts
grep -rlnE "from ['\"]eve" tests | xargs grep -lnE "node_modules/eve|dist/|CHANGELOG|version" 2>/dev/null
grep -rniE "regression|upstream|compat" tests -l
```

Means: the project pays to detect eve behavior changes. Each script or test is
a place eve moved without a stable contract. Record what each one checks and
which eve change motivated it (git log on the file).

Area: contract stability, upgrade notes, changelog quality.

## S7. Vendored, forked, or pinned-around packages

Search:

```sh
ls vendor 2>/dev/null
grep -nE "\"file:|patch|overrides|resolutions" package.json
ls patches 2>/dev/null
```

Means: an eve extension, channel, or peer package did not work at the pin and
the project rebuilt it. Read the vendored README or commit for the reason.

Area: extension compatibility, peer dependency policy.

## S8. The project's own words

Search:

```sh
grep -rniE "\beve\b.*(workaround|because|until|cannot|can't|does not|doesn't|no (equivalent|way|support)|limitation|bug|upstream|todo|fixme|hack)" agent docs tests scripts --include='*.ts' --include='*.md'
grep -rniE "(workaround|because|until|cannot|can't|does not|doesn't|limitation|bug|upstream|todo|fixme|hack).*\beve\b" agent docs tests scripts --include='*.ts' --include='*.md'
git log --all --format='%h %ad %s' --date=short -i --grep='eve' --grep='upstream' --grep='workaround' --grep='regression' --grep='pin' --grep='upgrade'
```

Means: direct testimony. Quote it. These lines usually name the gap better
than inference does, and they date it.

Area: any.

## S9. Disabled or avoided eve features

Search:

```sh
grep -rnE "(budget|limit|deadline|timeout|compaction|policy)[A-Za-z]*\s*:\s*(false|null|undefined|0|Infinity)" agent
grep -rniE "disabled|opt.?out|turned off|not use|avoid" agent docs --include='*.ts' --include='*.md' | grep -iE "eve|budget|task|sandbox|memory|compaction"
```

Also empty event overrides, which suppress an eve default handler:

```sh
grep -rnE "\"[a-z]+\.[a-z_]+\"\s*\(\)\s*\{\s*\}|async \"[a-z]+\.[a-z_]+\"\(\)\s*\{\s*\}" agent
```

Means: an eve default did not fit and the project turned it off instead of
tuning it. Ask why in the record; a feature turned off "at the user's request"
with no alternative is a docs or defaults finding, not a gap. A default turned
off and then rebuilt elsewhere (limits off plus a budget middleware; checkout
off plus project-owned git) is one record covering both halves.

Area: defaults, configuration surface.

## S10. Feedback already given

Search:

```sh
git shortlog -sne | head
gh issue list -R vercel/eve --state all --limit 100 --search "<org name>"
gh search issues --repo vercel/eve --author <login>  # per contributor
grep -rnoE "github\.com/vercel/eve/(issues|pull|discussions)/[0-9]+" . --include='*.md' --include='*.ts' | sort -u
```

Means: gaps the team already reported. Link each to a record and note the
issue state. An open issue with a workaround still in the tree is the
strongest form of evidence for a gap.

Area: any.

## S11. Upgrade churn

Search:

```sh
git log --format='%h %ad %s' --date=short -p -- package.json | grep -E '^[0-9a-f]{7} |"eve":'
git log --format='%h %ad %s' --date=short --stat -- package.json | grep -B3 -A15 -iE "eve"
```

Means: each pin change that touched many files is a behavior change the
project had to absorb. For the biggest ones, diff `node_modules/eve/CHANGELOG.md`
between the two versions and name the entry that forced the change. Missing
or vague changelog entries are a finding.

Area: contract stability, changelog, upgrade notes.

## S12. Tool shape

Search: `sweep.sh` S12 prints tool families (shared name prefix, ≥2
members), their total lines, how many carry their own `approval:` config, and
which `lib/` modules they import in common; then which tool names the prompt
mentions.

Means: many narrow tools over one backend, each with its own approval, where
one broad tool with an input-dependent approval policy and instructions would
carry the same behavior. Open two members of the largest family and compare
their input schemas and `execute` bodies; note what actually differs. Check
what eve offers: `docs/tools/human-in-the-loop.md` documents approval policies
that receive `{ toolName, toolInput, … }`, so argument-scoped gating does not
require a separate tool. Report the facts in the report's "Tool shape"
section. It becomes a gap block only if an eve limitation forced the split
(for example an approval policy that cannot see the input at the pinned
version); cite the limitation.

Area: tool authoring, approval policy, scaffolding and docs guidance.

## S13. Code hygiene

Search: `sweep.sh` S13 prints formatter/linter presence, the line-length
distribution of the agent's TypeScript, and the densest files.

Means: agent-written code merged without a formatter reads as one-line
functions and 300-character statements. Record it as a fact in the subject
table; it explains why excerpts look the way they do and is evidence about
how eve projects get built. Check whether eve's own scaffold (`eve init`
templates) ships a formatter or linter; if it does not, say so in the same
row. Do not editorialize.

Area: scaffolding.

## Reading a hit

For every candidate, answer in order:

1. What eve signal, option, or primitive would make this unnecessary?
2. Does eve have it at the pinned version? Search `node_modules/eve/docs`.
3. Does eve have it now? Search the newest `CHANGELOG.md` entries.
4. Does an eve doc, type, or research note already promise it? Quote it.
5. How does the workaround fail when eve changes: loudly, or silently?

If you cannot answer 1, it is probably a product choice. Drop it.
