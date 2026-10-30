---
name: review
description: Comprehensive security and correctness audit. Use for review, deep review, thermo nuclear, or thermonuclear requests and branch or PR diff audits.
---

# Deep review

The worker subagent cannot run commands, so hand it the diff as a file. Write the change under review to a fresh file in the shared sandbox (`patch=$(mktemp)`, then `git -C <repo> diff --cached`, `diff HEAD`, or `diff <base>...<head>` into `"$patch"`); untracked files appear only after `git add -N`. Give the worker a self-contained audit instruction naming the repository and that patch path. The root agent evaluates findings and owns the final verdict.

Audit changed code and its necessary surrounding context for bugs, broken functionality, security vulnerabilities, developer-experience regressions, and feature-gate leaks. Cite repository evidence for every finding. Report only issues introduced or exposed by code added or modified in the reviewed change.

## Required checks

- Trace cross-package and runtime side effects end to end.
- Check authorization, untrusted input, credential disclosure, destructive behavior, and bounded work.
- Check local build and run workflows, changed environment variables, ports, networking, and required setup.
- Verify internal or gated features remain gated.
- Distinguish intended, well-contained breakage from accidental consequences.
- Calibrate priority carefully; do not inflate speculative or low-impact concerns.

Never present a finding with unfinished evidence. Name the exact missing file or ref instead. Run the independent audit before reading PR discussion so existing comments do not anchor it. Afterward, the root agent may compare findings with discussion, verify each against the workspace, and report only actionable defects.
