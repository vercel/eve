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
refusal actionable, fixes three parser defects, and gives each denial a bounded internal
reason code.

## Problem

- In an internal agent built on eve, the guard refuses about 5% of gh calls. The share
  is steady across eve releases with the same rule, and it is the agent's largest tool
  error class. Most refused calls recover on a later call, so the usual cost is a wasted
  round trip and its tokens.
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
  that literal text to GitHub, which is public and hard to undo. Decision 2 is the one
  exception.

| Token                                                  | Bash                                 | `main`                         | Decision                  |
| ------------------------------------------------------ | ------------------------------------ | ------------------------------ | ------------------------- |
| `\|`, `\|&`                                            | pipe                                 | refused                        | refuse, `pipe`            |
| `;`, `&&`, `\|\|`, `&`, unquoted newline               | chain, background, command separator | refused; a newline joins words | refuse, `chain`           |
| `<`, `>`, `>>`, `&>`, `2>&1`                           | redirect                             | refused                        | refuse, `redirect`        |
| `<<`, `<<<`                                            | heredoc                              | refused                        | refuse, `heredoc`         |
| `$(`, `<(`, `>(`, unquoted `` ` ``                     | command or process substitution      | refused                        | refuse, `substitution`    |
| `$((`, `$[`                                            | arithmetic                           | refused                        | refuse, `substitution`    |
| unquoted `$'` and `$"`                                 | ANSI-C and locale quoting            | refused                        | refuse, `substitution`    |
| `` ` `` inside double quotes                           | command substitution                 | refused                        | accept as literal         |
| `${`, `$NAME`, `$1`, `$?` and other special parameters | expansion                            | refused                        | refuse, `variable`        |
| any other `$`, such as `5$`, `US$`, `$ `               | literal                              | refused                        | accept as literal         |
| unquoted `{a,b}`, `{1..3}`, `{a..c}`                   | brace expansion into several words   | refused                        | refuse, `brace_expansion` |
| other braces, such as `{owner}`, `{}`, `{..}`, `{a..}` | literal                              | refused unquoted               | accept as literal         |
| unquoted `(`, `)`                                      | subshell or syntax error             | refused                        | accept as literal         |
| `NAME=value gh …`, `env …`                             | environment assignment               | refused by the program check   | refuse, `env_assignment`  |
| `cd dir && …`                                          | change directory, then chain         | refused at `&&`                | refuse, `cd`              |
| `cd dir`                                               | change directory                     | refused by the program check   | refuse, `cd`              |

Every newly accepted argv value was already reachable: the parser accepts any text inside
single quotes verbatim, and a single quote itself through double quotes or `\'`. The set
of argv values that reach `exec` stays the same, and only the accepted spellings change.

## Decisions

1. **Actionable messages.** Each refusal names the token and its fix in one or two
   sentences. A pipe points at `--jq` or `--template`. A chain asks for one command per
   call. A redirect, heredoc, or command substitution points at `--body-file`, `--input`,
   or single quotes. Arithmetic asks for the computed value, ANSI-C quoting for plain
   quotes, and a variable for the value itself or an escaped `\$`. A brace list asks for
   each argument, or quoted braces. `cd` and `git -C dir` name `workingDirectory` and the
   directory, `git -c` points at `git config` in bash, and `--no-pager` is dropped. Other
   git subcommands list the supported ones. When a quote is left open, the refusal
   reports the open quote before any operator the misquoted text exposed, and explains
   that an apostrophe ends single-quoted text. The parser stops at the end of a heredoc
   line, so an apostrophe in the body reports the heredoc, and it reports `$'` where it
   starts, because its escapes differ from plain quotes. An environment-assignment message echoes
   the variable name, not the value.
2. **Backticks only inside double quotes.** This is an explicit exception to "no silent
   literals": bash runs a backtick inside double quotes, and the tool sends it as text.
   Markdown bodies put code spans there, and a code span is what models write there. An
   unquoted backtick stays refused, and single quotes send any backtick as text in both.
3. **Brace lists stay refused.** Bash expands an unquoted group that holds a comma, or a
   sequence of integers or single letters, into several words. The tool sends one word.
   Other braces, including the `{owner}`, `{repo}`, and `{branch}` placeholders `gh api`
   fills in, are literal in bash and are accepted.
4. **Parentheses and literal `$` are accepted.** A `$` is literal wherever bash leaves it
   literal. Unquoted parentheses are a bash syntax error, and the tool sends them as
   text.
5. **Authenticated git names origin first.** `git push -u origin x` is refused before the
   command runs, with a message that moves `-u` after the remote and refs.
6. **Internal denial code.** The parser's error carries a reason code. eve exports no type
   for it and `githubShellApproval` returns only `{ type: "denied", reason }`, so the
   values can change until the tracing follow-up defines them. The values are `pipe`,
   `chain`, `redirect`, `heredoc`, `substitution`, `variable`, `brace_expansion`,
   `env_assignment`, `cd`, `program`, `gh_subcommand` (bare `gh`), `git_subcommand`,
   `git_option` (an option such as `-C` before the subcommand), `git_remote` (anything
   other than `origin` after the subcommand), `unterminated_quote`, and `invalid_input`
   (empty command, NUL character, bad permission, or missing description).
7. **One source for usage rules.** The tool description states every rule a model needs:
   one command per call, the refused syntax including brace lists, unquoted backticks,
   `$'…'`, and `$((…))`, `--jq '<expr>'`, `--body-file <path>`, `workingDirectory`, the
   supported git subcommands, and `origin` right after the subcommand with options after
   the refs. The GitHub instructions point at it, and `docs/code-extension.mdx` states
   the rule in one sentence.

A separate follow-up carries the code to the tool span as `agent.action.denial.reason`.

## Existing parser defects

The parser on `main` also diverges from bash for inputs it accepts. This change fixes
three of them:

- A backslash before a newline continues the line. The parser now removes each
  backslash-newline pair outside single quotes before it reads the command, as bash's
  reader does, so `$\` followed by a newline and `(id)` is `$(id)` and is refused. On
  `main` the pair became a literal newline argument.
- Inside double quotes, a backslash is kept unless the next character is `$`, `` ` ``,
  `"`, `\`, or a newline. On `main` the parser dropped it before any character, so
  `"C:\path"` gave `C:path`.
- An unquoted newline is refused as `chain`. On `main` it joined two commands into one
  argv.

Words split only on space, tab, and newline, as in bash, so a non-breaking space or a
carriage return stays inside a word. Unquoted `#` (a bash comment) and `~` (the home
directory) still pass through as text. The tool hands gh an extra argument or an
unexpanded path, and changes no published text.

## Bash parity

The scenario test `packages/eve-git/test/scenario/github-command-shell.test.ts` builds
its corpus from a token table that matches the one above. Each token appears in a word,
alone, inside double quotes, and inside single quotes when it holds no apostrophe. bash runs every command with
default options, in a temporary directory that holds files, with only `HOME` and `PATH`
set, and a `gh` function that prints its argv. A command expected to match bash fails
the test if bash exits non-zero. The test passes with bash 3.2.57 (macOS) and bash 5.2.15
(Debian).

- Accepted commands produce the same argv as bash, including `{owner}`, `{..}`, and
  `{a..}`, quoted and escaped brace lists, literal `$`, any token inside single quotes,
  line continuations, and backslashes inside double quotes.
- Accepted commands diverge from bash only here. A backtick inside double quotes runs a
  command in bash. Unquoted parentheses are a bash syntax error. An unquoted `#` that
  starts a word starts a comment. A `~` that starts a word, or follows the `=` of an
  assignment-like word such as `body=~/n.md`, expands to the home directory. A `*`, `?`,
  or bracket expression such as `[ax]` that matches files expands to their names. The
  input schema trims leading and trailing whitespace before parsing, so a trailing `\ `
  is lost.
- bash 3.2 leaves a brace sequence with an increment, such as `{1..3..+1}`, literal, and
  bash 4 and later expand it. The parser refuses it, and the unit tests cover it outside
  the parity table.
- Each refused command makes bash exit non-zero or produce an argv that differs from the
  literal text.
- The single-quoted `exec` form survives `sh` (dash on Debian) and `bash -lc` unchanged
  for an adversarial corpus: `$(id)`, backticks, `;`, `&&`, `|`, `>`, a newline,
  `'"'"'`, an apostrophe, `${HOME}`, `~`, `*`, `?`, an empty string, padding spaces, and
  a lone backslash. The parser refuses a NUL character before quoting, because a command
  line cannot carry one.

## Externally observable semantics

This change applies to every agent that mounts `git({ github })` or `defineGhTool`, and
to custom tools that call `executeGitHubShell` or `githubShellApproval`.

- Commands that `main` refused now run: backticks inside double quotes, braces outside
  brace lists, unquoted parentheses, and literal `$`.
- Commands that `main` accepted now parse differently: a line continuation joins the
  lines, and a backslash inside double quotes stays unless bash removes it.
- Commands that `main` accepted are now refused: an unquoted newline and a NUL character.
  `git push -u origin x` is refused before the command runs; on `main` it failed during
  execution.
- Every refusal has a new message. Consumers that match on message text must update.
- The `gh` tool description changed. It is now the single statement of the command
  rules, and the GitHub instructions refer to it.

The PR author owns the first-week measurement: the refusal share and the
retry-after-refusal rate in the internal agent, compared with the baseline above, and
grouped by reason once the tracing follow-up lands. Sampling published bodies and
titles that contain backticks shows whether models meant bash to expand any of them.

To revert, revert the eve patch release. There is no stored state to migrate.

## Alternatives considered

- **Teach the model only.** Change the description and instructions, and keep the guard
  and messages. The description already said "simple argv quoting only, never …
  substitutions", and the refusal share did not move across releases. This also leaves
  the `-C` message wrong.
- **Actionable messages, relax nothing.** This fixes the guidance and the `-C` message.
  Each body with a code span or `{owner}` path still costs one refused call and a
  rewrite.
- **Structured input** (`args: string[]` in place of `command`). This removes parsing
  and every quoting question. The deciding argument is model behavior: whether models
  produce argv arrays for long Markdown bodies as reliably as command strings, and how
  many refusals remain after this change. Neither is measured yet. The reason codes
  exist to measure the second. Follow-up, owned by the PR author: decide on
  `args: string[]` after one week of reason-code data from the tracing follow-up. The
  change breaks the input schema for every agent that uses the tool, with its prompts
  and evals.
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
  refused, including when a line continuation splits them. An open quote reports
  `unterminated_quote` before an operator the misquoted text exposes. `git -C x push`
  returns `git_option` and names `workingDirectory`. An environment-assignment message
  never contains the assigned value.
- Integration (`packages/eve-git/test/integration/github-shell.test.ts`): the full
  `sandbox.run` command string is `cd '<dir>' && exec '<trusted gh>'` followed by each
  argv value single-quoted.
- Scenario (`packages/eve-git/test/scenario/github-command-shell.test.ts`): the bash
  parity and round-trip checks above.
