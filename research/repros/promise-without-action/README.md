---
issue: TBD
status: draft
last_updated: "2026-08-25"
---

# Promise without action repro

This standalone repro captures a historical `eve@0.39.1` behavior with
`anthropic/claude-opus-4.8`:

1. An initial turn calls a tool that parks for approval.
2. A follow-up corrects the target and asks for a revised submission.
3. The model says it will revise and submit the plan, sometimes rendering a
   textual imitation of a tool call, but requests no real action.

The same prompt and tools pass when the initial tool is not approval-gated. This
isolates the behavior to model interaction with the pending-approval state rather
than generic tool selection.

The fixture is synthetic. It contains no production prompts, conversation text,
people, workspace identifiers, record identifiers, or application-specific code.
It intentionally installs the historical package in a temporary directory rather
than adding an old runtime to the workspace lockfile.

## Run

The repro uses the AI Gateway credential already available in the environment:

```sh
bash research/repros/promise-without-action/repro.sh
```

Set `RUNS` to repeat each variant (default: `3`) and `KEEP_REPRO=1` to retain the
temporary app and eval artifacts for inspection:

```sh
RUNS=1 KEEP_REPRO=1 bash research/repros/promise-without-action/repro.sh
```

The script expects the approval-gated variant to fail its
`calledTool("emit-revised-change-plan")` assertion and the ungated control to
pass. It exits non-zero when either expectation is not met.

## Observed result

On August 25, 2026, the approval-gated variant reproduced in 3/3 runs. Every
follow-up emitted zero real tool actions while claiming the revised plan had
been or would be submitted. The ungated control passed in 3/3 runs and called
`emit-revised-change-plan` with the corrected target.

Current eve has since changed pending-approval handling. This artifact pins the
historical runtime to preserve the original execution conditions; it is not a
claim that current eve produces the identical transcript.
