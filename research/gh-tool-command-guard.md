---
issue: "None (maintainer proposal; implemented in #5458)"
status: in-progress
last_updated: "2026-10-27"
---

# gh tool command guard

## Summary

The `gh` tool parses a command string into argv and runs it without a shell. Its guard
refuses shell syntax, unsupported programs, and unsupported git subcommands. The guard
refuses characters that are harmless without a shell, and its messages name neither the
offending token nor the fix. This change accepts the harmless characters, makes each
refusal actionable, fixes three parser defects, and attaches a bounded reason code to
each denial.

## Problem

- In a Vercel agent built on eve, the `code__gh` tool refuses about 4.6% of calls, 100
  to 160 a day. The rate is steady across eve 0.77 to 0.84, which share the same rule. It
  is the agent's largest tool error class. About 90% of refused calls recover on a later
  call, so the usual cost is a wasted round trip and its tokens.
- The parser refuses backticks, `{`, `}`, `(`, `)`, and `$` outside quotes, and `$` or a
  backtick inside double quotes. Markdown code spans in `--body` and `--title`, and the
  `{owner}/{repo}` placeholders that `gh api` fills in itself, trip it.
- Every syntax refusal returns one message: "GitHub commands support argv syntax only, not
  pipes, redirects, substitutions, or shell operators." It names neither the token nor the
  fix.
- `git -C dir push origin main` is refused because `-C` sits in the subcommand position.
  The message says that authenticated git supports fetch, ls-remote, pull, and push, so
  it points the model at the command it already sent.

The breakdown of refusals by token is unknown: denials carry only free text. The reason
codes below make that breakdown measurable.

## What the guard provides

```text
command string ─parseCommand─▶ argv ─validate─▶ program and git subcommand checks
  └─▶ sandbox.run("cd '<dir>' && exec '<program>' '<arg>' …")   inside the credential lease
```

Each argv value is single-quoted at `exec`, so no argument reaches a shell as syntax.
During the lease, the firewall exchanges a placeholder for a token scoped to the declared
repository. `gh api` already exposes everything that token allows, so the guard is not
what limits GitHub access. Sandbox process hardening is out of scope here and tracked
separately.

The guard provides two things:

- **Legible intent.** Each call is one `gh`, `gh-signed-commit`, or authenticated `git`
  remote command. The trace shows the command, and `description` states the intended
  result.
- **No silent literals.** When bash gives a token a meaning that the tool does not
  honor, the guard refuses it. If the tool accepted `$(cat notes.md)`, gh would publish
  that literal text to GitHub, which is public and hard to undo.

| Token                                                  | Bash                                 | `main`                                 | Decision                  |
| ------------------------------------------------------ | ------------------------------------ | -------------------------------------- | ------------------------- |
| `\|`, `\|&`                                            | pipe                                 | refused                                | refuse, `pipe`            |
| `;`, `&&`, `\|\|`, `&`, unquoted newline               | chain, background, command separator | refused; a newline joins both commands | refuse, `chain`           |
| `<`, `>`, `>>`, `&>`, `2>&1`                           | redirect                             | refused                                | refuse, `redirect`        |
| `<<`, `<<<`                                            | heredoc                              | refused                                | refuse, `heredoc`         |
| `$(`, `$((`, `$[`, `<(`, `>(`, unquoted `$'` and `$"`  | substitution, ANSI-C quoting         | refused                                | refuse, `substitution`    |
| unquoted `` ` ``                                       | command substitution                 | refused                                | refuse, `substitution`    |
| `` ` `` inside double quotes                           | command substitution                 | refused                                | accept as literal         |
| `${`, `$NAME`, `$1`, `$?` and other special parameters | expansion                            | refused                                | refuse, `variable`        |
| any other `$`, such as `5$`, `US$`, `$ `               | literal                              | refused                                | accept as literal         |
| unquoted `{a,b}`, `{1..3}`                             | brace expansion into several words   | refused                                | refuse, `brace_expansion` |
| other braces, such as `{owner}`, `{}`                  | literal                              | refused unquoted                       | accept as literal         |
| unquoted `(`, `)`                                      | subshell or syntax error             | refused                                | accept as literal         |
| `NAME=value gh …`, `env …`                             | environment assignment               | refused by the program check           | refuse, `env_assignment`  |
| `cd dir && …`                                          | change directory, then chain         | refused at `&&`                        | refuse, `cd`              |
| `cd dir`                                               | change directory                     | refused by the program check           | refuse, `cd`              |

Every newly accepted argv value was already reachable: the parser accepts any text inside
single quotes verbatim, and a single quote itself through double quotes or `\'`. The set
of argv values that reach `exec` stays the same, and only the accepted spellings change.

## Decisions

1. **Actionable messages.** Each refusal names the token and its fix in one or two
   sentences. A pipe points at `--jq` or `--template`. A chain asks for one command per
   call. A redirect, heredoc, or substitution points at `--body-file`, `--input`, or
   single quotes. A variable asks for the value itself, or single quotes. A brace list
   asks for each argument, or quoted braces. `cd` and `git -C dir` name
   `workingDirectory` and the directory. Other git subcommands list the supported ones.
   An unterminated single quote explains that an apostrophe ends single-quoted text. An
   environment-assignment message echoes the variable name, not the value.
2. **Backticks only inside double quotes.** Markdown bodies put code spans there. An
   unquoted backtick stays refused: bash runs its contents, and double or single quotes
   send it as text.
3. **Brace lists stay refused.** Bash expands unquoted `{a,b}` and `{1..3}` into several
   words, and the tool sends one word. Other braces, including the `{owner}`, `{repo}`,
   and `{branch}` placeholders `gh api` fills in, are literal in bash and are accepted.
4. **Parentheses and literal `$` are accepted.** A `$` is literal wherever bash leaves it
   literal. Unquoted parentheses are a bash syntax error, and the tool sends them as
   text.
5. **Denial code.** `githubShellApproval` returns `{ type: "denied", reason, code }`.
   `code` is internal: eve exports no type for it and documents no contract, so the
   values can change until the tracing follow-up defines them. The values are
   `pipe`, `chain`, `redirect`, `heredoc`, `substitution`, `variable`,
   `brace_expansion`, `env_assignment`, `cd`, `program`, `gh_subcommand` (bare `gh`),
   `git_subcommand`, `git_option` (an option such as `-C` before the subcommand),
   `unterminated_quote`, and `invalid_input` (empty command, NUL character, bad
   permission, or missing description).
6. **Model-facing text.** The tool description, the GitHub instructions, and
   `docs/code-extension.mdx` each state the rule in one or two sentences.

The code does not reach traces yet. `normalizeApprovalStatus` keeps only `type` and
`reason`. Putting the code on the tool span needs three changes in core. First, the
denied `ApprovalStatus` gets an optional `code`, a public API addition. Second,
`publishDenial` writes it to `call.settled.reason`, which `native-events.ts` already
forwards as `event.reason`. Third, the tool instrumentation sets
`agent.action.denial.reason` when the outcome is `rejected`. These changes touch the
harness and tracing, so they belong in a separate change.

## Existing parser defects

The parser on `main` also diverges from bash for inputs it accepts. This change fixes
three of them:

- A backslash before a newline continues the line. On `main` it became a literal
  newline argument: `gh pr create \` followed by a newline and `--title x` passed
  `"\n"` to gh as a positional argument.
- Inside double quotes, a backslash is kept unless the next character is `$`, `` ` ``,
  `"`, `\`, or a newline. On `main` the parser dropped it before any character, so
  `"C:\path"` gave `C:path`.
- An unquoted newline is refused as `chain`. On `main` it joined two commands into one
  argv.

Unquoted `#` (a bash comment) and `~` (the home directory) still pass through as text.
The tool hands gh an extra argument or an unexpanded path, and changes no published text.

## Bash parity

The scenario test `packages/eve-git/test/scenario/github-command-shell.test.ts` runs
each command in real bash with default options, in an empty temporary directory with
only `HOME` and `PATH` set, through `printf '%s\0'`. It passes with bash 3.2.57 (macOS)
and bash 5.2.15 (Debian).

- Accepted commands produce the same argv as bash, including `{owner}` paths, quoted
  and escaped brace lists, literal `$`, single-quoted `$(…)` and backticks, line
  continuations, and backslashes inside double quotes.
- Accepted commands diverge from bash in four places. A backtick inside double quotes
  runs a command in bash. Unquoted parentheses are a bash syntax error. A `#` starts a
  bash comment. A `~` expands to the home directory.
- Each refused command produces a bash argv that differs from the literal argv the tool
  sends without the guard.
- The single-quoted `exec` form survives `sh` unchanged for an adversarial corpus:
  `$(id)`, backticks, `;`, `&&`, `|`, `>`, a newline, `'"'"'`, an apostrophe, `${HOME}`,
  `~`, `*`, an empty string, padding spaces, and a lone backslash. The parser refuses a
  NUL character before quoting, because a command line cannot carry one.

## Externally observable semantics

This change applies to every agent that mounts `git({ github })` or `defineGhTool`. In
Vercel's API monorepo, four agents run the parser: v, sre, qwizard, and the
`preset-author` subagent of connect0. All four mount `code({ github })` on eve 0.83.3.
v, sre, and connect0 also wrap the packaged `gh` tool and call `executeGitHubShell`,
which applies the same parser. They take this change when they move to
`git({ github })` and `eve/extensions/git/*`.

- Commands that `main` refused now run: backticks inside double quotes, braces outside
  brace lists, unquoted parentheses, and literal `$`.
- Commands that `main` accepted now parse differently: a line continuation joins the
  lines, and a backslash inside double quotes stays unless bash removes it.
- Commands that `main` accepted are now refused: an unquoted newline and a NUL character.
- Every refusal has a new message. Consumers that match on message text must update.
- `githubShellApproval` denials carry an internal `code` field.

Owner: @pcomans. In the first week after v upgrades, compare the refusal rate and the
retry-after-refusal rate with the baseline above, using
`service:v env:production @gen_ai.tool.name:code__gh @error.type:TOOL_EXECUTION_DENIED`.
After the tracing follow-up lands, group that query by `@agent.action.denial.reason`.
Sample published bodies and titles that contain backticks to find text the model meant
bash to expand.

To revert, revert the eve patch release. There is no stored state to migrate.

## Alternatives considered

- **Teach the model only.** Change the description and instructions, and keep the guard
  and messages. The description already says "simple argv quoting only, never …
  substitutions", and the refusal rate did not move across versions. This also leaves
  the `-C` message wrong.
- **Actionable messages, relax nothing.** This fixes the guidance and the `-C` message.
  Each body with a code span or `{owner}` path still costs one refused call and a
  rewrite.
- **Structured input** (`args: string[]` in place of `command`). This removes parsing
  and every quoting question. The deciding argument is model behavior: whether models
  produce argv arrays for long Markdown bodies as reliably as command strings, and how
  many refusals remain after this change. Neither is measured yet. The reason codes
  exist to measure the second. Follow-up, owner @pcomans: decide on `args: string[]`
  after one week of reason-code data from the tracing follow-up. The change breaks the
  input schema for every agent that uses the tool, with its prompts and evals.
- **One tool per operation** (`gh_pr_create { title, body }`). This removes quoting for
  common writes. It duplicates the gh surface, and this tool exists to expose the full
  gh CLI.
- **A real shell with expansion.** `$(…)` could then run any program inside the
  credential lease. Rejected.
- **Rewrite common patterns** (`cd dir && …` to `workingDirectory`, drop `| cat`). This
  hides what ran and grows a second command language. Rejected.

## Tests

- Unit (`packages/eve-git/test/unit/github-command.test.ts`): each code returns its
  message, and the message names the token and the fix. Accepted spellings parse to the
  expected argv and are approved. `$(`, `${`, `$NAME`, and unquoted backticks stay
  refused. `git -C x push` returns `git_option` and names `workingDirectory`. An
  environment-assignment message never contains the assigned value.
- Integration (`packages/eve-git/test/integration/github-shell.test.ts`): the full
  `sandbox.run` command string is `cd '<dir>' && exec '<trusted gh>'` followed by each
  argv value single-quoted.
- Scenario (`packages/eve-git/test/scenario/github-command-shell.test.ts`): the bash
  parity and `sh` round-trip checks above.
