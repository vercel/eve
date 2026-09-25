---
name: review
description: Comprehensive security and correctness audit. Use for review, deep review, thermo nuclear, or thermonuclear requests and branch or PR diff audits.
---

# Deep review

Give the worker subagent a self-contained audit instruction naming the repository and target ref or worktree. The worker inspects the shared checkout directly. The root agent evaluates findings and owns the final verdict.

Audit changed code and its necessary surrounding context for bugs, broken functionality, security vulnerabilities, developer-experience regressions, and feature-gate leaks. Cite repository evidence for every finding. Report only issues introduced or exposed by code added or modified in the reviewed change.

## Required checks

- Trace cross-package and runtime side effects end to end.
- Check authorization, untrusted input, credential disclosure, destructive behavior, and bounded work.
- Check local build and run workflows, changed environment variables, ports, networking, and required setup.
- Verify internal or gated features remain gated.
- Distinguish intended, well-contained breakage from accidental consequences.
- Calibrate priority carefully; do not inflate speculative or low-impact concerns.

Never present a finding with unfinished evidence. Name the exact missing file or ref instead. Run the independent audit before reading PR discussion so existing comments do not anchor it. Afterward, the root agent may compare findings with discussion, verify each against the workspace, and report only actionable defects.
