---
name: eve-friction-report
description: Audit an eve project for the places where the team works around eve instead of using it, and write a gap register for the eve team, with every gap a self-contained block cited to file:line and backed by verbatim code. Use when an eve user wants to tell the eve team what is missing, before or after an eve version upgrade, or when a project has grown its own supervisors, outboxes, guards, or wrappers around eve.
---

# eve friction report

You are auditing an eve project on behalf of its team. The output is a gap
register: every real, verifiable place where eve fell short and the project
had to work around it, each as a self-contained block with what eve says,
what the project built, how it fails, and the code. Facts and citations. No
methodology, no proposals, no verdicts, no restructuring advice, no
code-quality review. When the project does something eve already supports,
it is not a gap; leave it out.

Read all of these before starting, in this order:

1. `references/example-report.md` — the target shape, and a weak block
   with why it fails. `examples/slack-company-agent-2026-09-29.md` is the
   full anonymized report those blocks came from; open it only when you need
   to see how a whole section (index, upgrade exposure, tool shape) reads at
   17 gaps.
2. `references/signals.md` — what each signal class means and what to look
   for when you open a hit.
3. `references/report-template.md` — the skeleton you fill.

Scripts under `scripts/` do the mechanical parts. Use them instead of
retyping searches; they are what makes two runs of this skill agree.

## Ground rules

- **Anonymized by construction.** The report will leave the team's hands and
  may be published or aggregated. It must not contain the organization's
  name, product or agent names, people's names or handles, internal app
  names, hostnames, Slack/Teams IDs, emails, tokens, or non-public URLs.
  Placeholders (`<org>`, `<agent>`, `<person-1>`, `<app-1>`, `<host>`,
  `<slack-id>`, `<email>`, `<url>`) stand in for them, including inside file
  paths and code excerpts. `scripts/redact.mjs` applies a local map;
  `scripts/check-report.mjs` refuses a report with any leak. The map lives
  in a scratch directory outside the tracked tree and is never shipped.
  Do not cite the number of an issue filed by the project's own contributors;
  say how many and their state. Third-party vendor names (Slack, Shopify,
  Redis) and public eve issue numbers filed by others are fine.
  What this protects against: a reader or search engine linking the report
  to the organization by name, handle, ID, or codename. What it does not
  protect against: someone who already has the source recognizing it from
  the excerpts, which are verbatim by design. If the report may be published
  beyond the eve team, get the team's consent first; anonymization is not a
  substitute for it.
- Read-only. Do not change, commit, deploy, or query production systems.
- Every claim carries a citation (`path:line` or `path:line-line`, commit
  SHA, issue URL) and an evidence tag: `[V]` you read it, `[I]` inferred from
  the code path, `[R]` unverified. Never upgrade a tag to make a point.
- Compare against the eve version the project runs. Docs and changelog for
  it are in `node_modules/eve/docs/**` and `node_modules/eve/CHANGELOG.md`.
  Then check the newest eve. "A newer eve has it" is still a gap: it tells
  the eve team the docs or upgrade notes did not reach this user.
- Quote eve and the project verbatim. Paraphrase is where errors enter.
- No production data unless the user hands it to you. Say what you could not
  verify, inline, with `[I]` or `[R]` on that clause.
- Write for the eve team. They know eve; they do not know this project. Name
  the project's concept once, then use eve vocabulary.

## Workflow

Keep a scratch directory, `.eve-friction/`, outside the project's tracked
tree (or in a temp directory). It holds `subject.md`, `sweep.md`,
`records.md`, and `anonymize.json`. Append to `records.md` as you go; long
audits lose records otherwise. Never commit or share this directory: the
map inside it is the key to the report's anonymization.

### 1. Subject

```sh
bash <skill-dir>/scripts/subject.sh <project-root> > .eve-friction/subject.md
```

Read it. If `installed` is "not installed", get the pinned package on disk
without running scripts (`npm pack eve@<pin>` into a temp dir and extract, or
`npm ci --ignore-scripts` if the user allows), so `docs/` and `CHANGELOG.md`
are readable. Get the newest changelog the same way (`npm pack eve@latest`).
For eve source citations you may also shallow-clone
`https://github.com/vercel/eve` at the tag `eve@<pin>`; source is optional,
docs and changelog are not.

Record which sources you used. `installed` stays `[R]` until read from a
real checkout.

Now write `.eve-friction/anonymize.json` before reading any code, so you
carry the placeholders from the first record on:

```json
{
  "org": ["<org name>", "<org abbreviation used in filenames>"],
  "agent": ["<agent or product name>"],
  "people": [["<Full Name>", "<github-login>", "<first name>"]],
  "apps": [["<Internal app>", "<its lowercase filename token>"]],
  "hosts": ["<internal.hostname>"],
  "extra": { "<Region/City tz>": "<tz>" },
  "paths": { "<org>": "<abbreviation>", "<app-1>": "<token>" }
}
```

Fill it from `subject.md`: the repo owner, `git shortlog` authors and their
GitHub logins, names in `instructions.md`, and every internal product or
app token that appears in `lib/` filenames. Add to it whenever you meet a
new identifier while reading. `paths` tells the checker which alias appears
in filenames so it can find the source behind a redacted path.

### 2. Sweep

```sh
bash <skill-dir>/scripts/sweep.sh <project-root> > .eve-friction/sweep.md
```

Then run the `gh` searches from `references/signals.md` S10 by hand for each
contributor login (exclude eve maintainers who also committed here). Read
every section of the sweep. Every hit is a candidate; a hit is not a finding
until you have opened the file.

Two sections are exhaustive and must be read line by line, not skimmed:
**S0** (every comment in the project that mentions eve) and **S3's schedule
list** (open every file under `schedules/`). Each S0 line is a candidate on
its own, even when the same file already produced a record.

### 3. Read candidates

Open each candidate. Decide in one pass:

- **W** workaround: built because eve lacks it, or eve's version did not fit.
- **N** native: uses an eve primitive as documented. Drop.
- **P** product: a choice the project would make on any framework. Drop
  unless it depends on eve internals.

Do not stop at the first W in a file. Workarounds cluster: a supervisor
schedule implies a state store, a delivery path, and prompt text about it.

If the project has more than about 50 files under its `lib/` or equivalent
and your harness supports parallel subagents, split the reading into three
slices, each producing Step-4 records: (a) tasks, delegation, delivery,
schedules, progress; (b) auth, session ownership, HITL, channel ingress and
presentation; (c) models, cost, subagent composition, sandbox, extensions,
upgrade churn. Slice reviewers over-report. Re-open every file you will
excerpt yourself before writing.

### 4. Record each W

Append one record per W to `.eve-friction/records.md`:

| Field      | What goes here                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gap        | The eve capability that is missing, wrong, or undocumented, named by its eve primitive, option, or event.                                                       |
| Where      | Files and line ranges; approximate lines.                                                                                                                       |
| Since      | Date of the first commit (`git log --diff-filter=A --format='%ad' --date=short -- <path>`) and the eve pin at that date (from `subject.md`). Date only; no SHA. |
| Own words  | Comments, docs, commit messages, verbatim.                                                                                                                      |
| eve at pin | Quote from `docs/**`, a type, or source at the pinned version, with `path:line`; or "silent" with the docs you searched.                                        |
| eve now    | Newest `CHANGELOG.md` entry that touches it, with version and SHA; or "none".                                                                                   |
| Tracked    | `gh issue list -R vercel/eve --state all --search "<terms>"`: number and state, or "none" with the terms.                                                       |
| Fails      | Loud or silent, and the exact dependency: event name, token format, response field, adapter key, changelog entry.                                               |
| Excerpts   | `path:start-end` ranges you will paste, chosen to show the workaround or the stated reason.                                                                     |

### 5. Filter

A record stays only if all three hold:

1. eve is the right place to close it: eve owns the state, protocol, timing,
   or rendering involved, or eve is the only place a hook or option could
   make it buildable on top.
2. Any eve project with the same shape would hit it; it is not this
   project's product policy.
3. The workaround disappears, or shrinks to configuration, once eve has it.

Give each surviving record a **Kind**, one of:

- `own` — eve must own it (the state, protocol, or timing is eve's).
- `buildable` — eve should expose an option, event, or hook so the project
  can build it; eve need not ship the feature.
- `docs` — eve has it; the docs are silent or wrong.
- `mismatch` — the project's design assumes a model eve does not have (for
  example blocking delegation on a background-task runtime). The block's
  "What eve says" states eve's model; "What the project built" states the
  assumption.

And an **Area** from: tasks, delivery, channels, auth, hitl, cost, budgets,
subagents, sandbox, extensions, models, schedules, tooling, docs. These two
words are what lets reports from different projects be compared; keep to the
lists.

Three mistakes drop real gaps. Do not make them:

- **A documented limitation is a gap, not an exemption.** "Parent-agent hooks
  do not fire for subagent turns" or "Route auth does not enforce session
  ownership" in eve's docs is evidence _for_ the gap: eve names the hole and
  the project filled it. Drop a record only when eve provides the capability
  and the project did not use it.
- **A heavier documented path does not cancel a gap.** If eve's answer is
  "package it as an extension" and the project instead maintains 58
  re-export files, the gap is real; cite both the doc and the file count.
- **Unverified is not a reason to drop.** If the project's own comment
  asserts an eve behavior you could not test, keep the record, quote the
  comment, and tag the behavior `[R]`.

One gap per block. If, while writing a block, you find a second eve
shortcoming (an undocumented runtime value, a missing option on an adjacent
API), it gets its own block, however small. Records that fail the test are
dropped, not written up. Use the test as a filter, never as content.

Before writing, re-read every dropped record once and ask: does a comment,
doc, or commit message in the project name an eve behavior? If yes, it is a
gap regardless of whether eve documents that behavior.

Also record upgrade exposure: every `CHANGELOG.md` entry between the pin and
the newest version that removes or changes something a file in this project
uses, with the files and whether the entry names it. Do this even when the
project is current.

### 6. Write

Fill `references/report-template.md`. Sections, in order: three lines of
facts, subject table, index, upgrade exposure, tool shape, then one block
per gap, ordered by workaround size, largest first. Size is a fact about the
project, not a severity: a 3-line override can mark a deeper gap than 3,000
lines of outbox. Do not let the order imply otherwise in prose.

Tool shape is a facts table from S12 plus one excerpt comparing two members
of the largest family. State counts, shared backends, approval placement,
and how many tool names the prompt routes by hand. Quote what eve's
approval docs support. When the project states a reason for narrow tools
(least privilege, audit by tool name, a non-technical audience), quote it;
narrow tools are sometimes a security boundary, and the section must not
read as if they never are. Do not write "should"; the numbers carry the point.
A family becomes a gap block only when an eve limitation forced the split,
and then the block cites that limitation like any other gap.

Each block must be readable with the rest of the report deleted. Four
labeled paragraphs — **Gap**, **What eve says**, **What the project built**,
**How it fails** — then code excerpts, each headed by a line containing
`` `path:start-end` `` and copied from the file, not retyped. Trim to the
lines that show the workaround or the stated reason. Elide only inside a
single long line, with `…`, and say so in the heading; never use a
standalone `…` line to skip source lines — cite two ranges instead
(`` `path:12-14, 30-33` `` or two excerpts). The checker rejects a
standalone `…`. Repeat a fact rather than cross-reference another block.

Cite project commits by date and pin (`since 2026-08-20, pin 0.37.0`), not
by SHA: a short SHA resolves straight back to the repository. eve's own
changelog SHAs are public and fine. `redact.mjs --project` replaces any
project SHA you leave in with `<sha>`, and the checker flags them.

Inline `[I]` and `[R]` on the exact clause they qualify; `[V]` at paragraph
end. No "should", no proposed shapes, no acceptance criteria, no priorities.

### 7. Redact, then check

```sh
node <skill-dir>/scripts/redact.mjs <report.md> --map .eve-friction --project <project-root>
node <skill-dir>/scripts/check-report.mjs <report.md> <project-root> --map .eve-friction \
  --eve node_modules/eve --eve <dir with the newest eve docs and changelog>
```

`redact.mjs` rewrites the report in place with placeholders and lists any
residual leak. Paste excerpts from the real files; redaction handles them,
and the checker compares each excerpt to the redacted source, so they stay
verbatim modulo anonymization.

`check-report.mjs` verifies: no mapped term, identifier class, or project
commit SHA anywhere in the report; the opening gap count equals index rows
equals blocks; every index anchor resolves to its heading; every block has
a valid `Kind: … · Area: …` line, the four paragraphs in order, at least one
excerpt, and a `[V]`; no "should", "propose", "recommend", "acceptance", or
priority labels in prose; **every quoted passage in "What eve says" exists
verbatim in the eve sources passed with `--eve`** (docs, changelog, or
source; issue titles written as `#123 "title"` are exempt); and every fenced
excerpt anywhere in the report matches the cited file lines verbatim modulo
redaction, with brace paths expanded and each alternative checked, blank
lines skipped, and in-line `…` allowed. Fix and rerun until it prints `OK`.
Do not deliver a report that fails the check.

The quote check is strict on purpose: a period where the doc has a comma
fails. Copy eve's sentences; do not reconstruct them from memory or join
table cells with slashes.

What the check does not do: it cannot tell whether a gap statement is true,
whether eve has the capability under another name, or whether "How it
fails" will happen. `OK` means the report is well-formed, anonymized, and
quotes real text. The judgment is still yours; tag it.

After it passes, read the report once more as a stranger would: a project
codename, a city, a customer's name in a fixture, or a distinctive env var
can identify the org without matching any rule. Add such terms to the map
and rerun.

### 8. Deliver

Hand over the report path and the checker's `OK` line. If the user asked for
a summary, give the opening three lines and the index; nothing more.
