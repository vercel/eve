---
name: review
description: Security and correctness audit of a branch, diff, or pull request. Use for review, deep review, or thermonuclear review requests.
---

# Review

Audit the changed code, and the code it depends on, for bugs, broken behavior, security vulnerabilities, and developer-experience regressions. Report only issues the change introduces or exposes, each with repository evidence.

## Check

- Side effects across packages and runtimes, traced end to end.
- Authorization, untrusted input, credential disclosure, destructive behavior, and unbounded work.
- Build, run, and setup changes: environment variables, ports, networking.
- Internal or gated features that stop being gated.
- Intended, contained breakage versus accidental consequences.

Rank findings by real impact and don't inflate speculative ones. When evidence is missing, name the file or ref instead of guessing. Form your own view before reading existing PR discussion, then reconcile with it. A review changes nothing in the workspace.
