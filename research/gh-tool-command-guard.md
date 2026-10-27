---
issue: "None (maintainer proposal; implemented in #5458)"
status: in-progress
last_updated: "2026-10-27"
---

# gh tool command guard

## Summary

The `gh` tool parses a command string into argv and runs it without a shell. Its guard
refuses shell syntax, unsupported programs, and unsupported git subcommands, and its
messages name neither the offending token nor the fix. This change makes each refusal
actionable, gives each denial an internal reason code, makes the tool description the
single statement of the command rules, and refuses a few inputs that `main` accepts but
cannot run as written. It accepts no command that `main` refuses. Accepting characters
that are harmless without a shell is deferred until sandbox process hardening lands.

## Problem

- In an internal agent built on eve, the guard refuses about 5% of gh calls. The share
  is steady across eve releases with the same rule, and it is the agent's largest tool
  error class. Most refused calls recover on a later call, so the usual cost is a wasted
  round trip and its tokens.
- Every syntax refusal returns one message: "GitHub commands support argv syntax only, not
  pipes, redirects, substitutions, or shell operators." It names neither the token nor the
  fix, so the model guesses its next attempt.
- `git -C dir push origin main` is refused because `-C` sits in the subcommand position.
  The message says that authenticated git supports fetch, ls-remote, pull, and push, so
  it points the model at the command it already sent.
- The parser refuses backticks, `{`, `}`, `(`, `)`, and `$` outside quotes, and `$` or a
  backtick inside double quotes. Markdown code spans and the `{owner}/{repo}` placeholders
  that `gh api` fills in trip it, though none of them expands without a shell.

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

| Token                                              | Bash                                 | Code now            | Deferred proposal                       |
| -------------------------------------------------- | ------------------------------------ | ------------------- | --------------------------------------- |
| `\|`, `\|&`                                        | pipe                                 | `pipe`              | refuse                                  |
| `;`, `&&`, `\|\|`, `&`, unquoted newline           | chain, background, command separator | `chain`             | refuse                                  |
| `\` before a newline                               | line continuation                    | `line_continuation` | join the lines                          |
| `<`, `>`, `>>`, `&>`, `2>&1`                       | redirect                             | `redirect`          | refuse                                  |
| `<<`, `<<<`                                        | heredoc                              | `heredoc`           | refuse                                  |
| `$(`, `$((`, `$[`, `<(`, `>(`, `$'`, `$"`, `` ` `` | substitution, arithmetic, quoting    | `substitution`      | refuse, except `` ` `` in double quotes |
| `${`, `$NAME`, `$1`, `$?`, and any other `$`       | expansion, or a literal `$`          | `variable`          | accept a literal `$`                    |
| unquoted `{`, `}`                                  | brace expansion for lists            | `brace_expansion`   | refuse only brace lists                 |
| unquoted `(`, `)`                                  | subshell or syntax error             | `subshell`          | accept as literal                       |
| `NAME=value gh …`, `env …`                         | environment assignment               | `env_assignment`    | refuse                                  |
| `cd dir`, `cd dir && …`                            | change directory                     | `cd`                | refuse                                  |

Text inside single quotes is always literal, and double quotes accept braces and
parentheses. The fix in each `brace_expansion`, `subshell`, and `variable` message is to
quote the text.

## Decisions

1. **Actionable messages.** Each refusal names the token and its fix in one or two
   sentences. A pipe points at `--jq` or `--template`. A chain asks for one command per
   call, and a line continuation for one line. A redirect, heredoc, or command
   substitution points at `--body-file`, `--input`, or single quotes. Arithmetic asks for
   the computed value, ANSI-C quoting for plain quotes, and a variable for the value
   itself or an escaped `\$`. Braces, parentheses, and a literal `$` ask for quotes.
   `cd` and `git -C dir` name `workingDirectory` and the directory, `git -c` points at
   `git config` in bash, and `--no-pager` is dropped. Other git subcommands list the
   supported ones. When a quote is left open, the refusal reports the open quote before
   any operator the misquoted text exposed, and explains that an apostrophe ends
   single-quoted text. The parser stops at the end of a heredoc line, so an apostrophe in
   the body reports the heredoc, and it reports `$'` where it starts, because its escapes
   differ from plain quotes. An environment-assignment message echoes the variable name,
   not the value.
2. **Internal denial code.** The parser's error carries a reason code. eve exports no type
   for it and `githubShellApproval` returns only `{ type: "denied", reason }`, so the
   values can change until the tracing follow-up defines them. The values are `pipe`,
   `chain`, `line_continuation`, `redirect`, `heredoc`, `substitution`, `variable`,
   `brace_expansion`, `subshell`, `env_assignment`, `cd`, `program`, `gh_subcommand`
   (bare `gh`), `git_subcommand`, `git_option` (an option such as `-C` before the
   subcommand), `git_remote` (anything other than `origin` after the subcommand),
   `unterminated_quote`, and `invalid_input` (empty command, NUL character, bad
   permission, or missing description).
3. **One source for usage rules.** The tool description states every rule a model needs:
   one command on one line per call, the refused syntax, single quotes around text with
   `$`, backticks, braces, or parentheses, `--jq '<expr>'`, `--body-file <path>`,
   `workingDirectory`, the supported git subcommands, and `origin` right after the
   subcommand with options after the refs. The GitHub instructions point at it, and
   `docs/code-extension.mdx` states the rule in one sentence.
4. **The accepted set does not grow.** Every command this change accepts, `main` accepts,
   with the same argv. The change refuses four kinds of input that `main` accepts but
   cannot run as written:
   - a NUL character, which a command line cannot carry;
   - an unquoted newline, which `main` joins into the previous command's argv;
   - a backslash before a newline, which `main` passes to gh as a newline argument;
   - authenticated git without `origin` right after the subcommand, such as
     `git push -u origin x`, which `main` approves and then fails during execution.

A separate follow-up carries the code to the tool span as `agent.action.denial.reason`.

## Deferred: accepting harmless characters

Accepting backticks inside double quotes, braces outside brace lists, unquoted
parentheses, and a literal `$` waits for sandbox process hardening. The design challenge
found that the program boundary needs that hardening before the guard accepts more
input. The deferred work also covers bash parity for accepted input: joining line
continuations, keeping a backslash inside double quotes unless bash removes it, and
splitting words only on space, tab, and newline. A parked draft carries that change and
a bash parity harness built from the token table.

The parity work records where accepted input still diverges from bash with or without
the deferred change: an unquoted `#` that starts a word starts a bash comment, a `~` at
the start of a word or after the `=` of an assignment-like word expands to the home
directory, and a glob that matches files expands to their names. The input schema trims
leading and trailing whitespace before parsing.

## Externally observable semantics

This change applies to every agent that mounts `git({ github })` or `defineGhTool`, and
to custom tools that call `executeGitHubShell` or `githubShellApproval`.

- No command that `main` refuses is accepted, and accepted commands keep their argv.
- A NUL character, an unquoted newline, a line continuation, and authenticated git
  without `origin` right after the subcommand are refused at approval.
- Every refusal has a new message. Consumers that match on message text must update.
- The `gh` tool description changed. It is now the single statement of the command
  rules, and the GitHub instructions refer to it.
- `githubShellApproval` keeps its `{ type: "denied", reason }` shape.

The PR author owns the first-week measurement: the retry-after-refusal rate in the
internal agent, compared with the current baseline, and the refusal share grouped by
reason once the tracing follow-up lands. That breakdown decides the deferred relaxation
and the structured-input follow-up.

To revert, revert the eve patch release. There is no stored state to migrate.

## Alternatives considered

- **Teach the model only.** Change the description and instructions, and keep the guard
  and messages. The description already said "simple argv quoting only, never …
  substitutions", and the refusal share did not move across releases. This also leaves
  the `-C` message wrong.
- **Accept harmless characters now.** This removes the refusals for code spans and
  `{owner}` paths, the cost the problem section measures. It is deferred until sandbox
  process hardening, as above.
- **Structured input** (`args: string[]` in place of `command`). This removes parsing
  and every quoting question. The deciding argument is model behavior: whether models
  produce argv arrays for long Markdown bodies as reliably as command strings, and how
  many refusals remain. Neither is measured yet. The reason codes exist to measure the
  second. Follow-up, owned by the PR author: decide on `args: string[]` after one week of
  reason-code data from the tracing follow-up. The change breaks the input schema for
  every agent that uses the tool, with its prompts and evals.
- **One tool per operation** (`gh_pr_create { title, body }`). This removes quoting for
  common writes. It duplicates the gh surface, and this tool exists to expose the full
  gh CLI.
- **A real shell with expansion.** `$(…)` could then run any program inside the
  credential lease. Rejected.
- **Rewrite common patterns** (`cd dir && …` to `workingDirectory`, drop `| cat`). This
  hides what ran and grows a second command language. Rejected.

## Tests

- Unit (`packages/eve-git/test/unit/github-command.test.ts`): each code returns its
  message, and the message names the token and the fix. Quoted text parses to the
  expected argv. An open quote reports `unterminated_quote` before an operator the
  misquoted text exposes, and a heredoc body reports `heredoc`. An environment-assignment
  message never contains the assigned value.
- Baseline (`packages/eve-git/test/unit/github-command-baseline.test.ts`): a corpus built
  from each token in a word, alone, and inside double and single quotes, plus whole
  commands, runs through the parser and through `main`'s validation. Every accepted
  command is accepted by `main` with the same argv, and every command `main` accepts
  that this change refuses falls under one of the four kinds in decision 4.
- Integration (`packages/eve-git/test/integration/github-shell.test.ts`): the full
  `sandbox.run` command string is `cd '<dir>' && exec '<trusted gh>'` followed by each
  argv value single-quoted.
- Scenario (`packages/eve-git/test/scenario/github-command-shell.test.ts`): the
  single-quoted `exec` form survives `sh` and `bash -lc` unchanged for an adversarial
  corpus, and the parser refuses a NUL character before quoting.
