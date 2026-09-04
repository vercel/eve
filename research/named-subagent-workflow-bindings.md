---
issue: TBD
status: draft
last_updated: "2026-09-03"
---

# Named subagent bindings in workflows

Expose declared subagents as callable named imports from `eve/workflow`, so authored
code can delegate work and branch on its result in both workflow tools and authored
workflow functions.

The proposed call is `await reviewer(message)`. eve supplies the target, invocation
context, and replay-stable invocation identity currently passed explicitly to
`agent(ctx, { target, key, message })`. This extends the workflow delegation described
in [Tools as workflows][tools-as-workflows].

## Proposed authoring API

The following examples describe the requested API, not code supported by the current
exports. `defineSubagent` and `defineWorkflow` retain the names from the initial
sketch; their inclusion is an open API decision below.

```ts
// agent/subagents/reviewer.ts
import { defineSubagent } from "eve";

export default defineSubagent({
  description: "Review an issue and report whether the review passes.",
  model: "openai/gpt-5.6-sol",
});
```

The filename supplies `reviewer`; no separate name or registration is authored.
Only named subagents receive generated bindings. The proposed `agent(prompt)` calls
a copy of itself, matching the built-in
[`agent` tool][agent-tool]'s target and root-only
availability. It does not select another named agent.

Importing a binding does not start an agent. Calling it starts a new child or
continues the child identified by `agentId`; awaiting it returns `[output, metadata]`
after that invocation completes.

```ts
// agent/tools/orchestration.ts
import { defineTool } from "eve/tools";
import { agent, reviewer } from "eve/workflow";
import { z } from "zod";

const ReviewSchema = z.object({ successful: z.boolean() });

export default defineTool({
  description: "Research and review an issue in parallel.",
  inputSchema: z.object({ issueDescription: z.string() }),
  async execute(input) {
    "use workflow";

    const [[research], [review]] = await Promise.all([
      agent("Research this: " + input.issueDescription),
      reviewer("Review this: " + input.issueDescription, { outputSchema: ReviewSchema }),
    ]);

    if (review.successful) return { successful: true, research };
    return { successful: false };
  },
});
```

The same bindings should be callable from an authored workflow function. The file
location does not determine how the workflow is started or which session owns it:

```ts
// workflows/orchestration.ts
import { defineWorkflow } from "eve";
import { agent, reviewer } from "eve/workflow";
import { z } from "zod";

const ReviewSchema = z.object({ successful: z.boolean() });

export default defineWorkflow(async (input: { issueDescription: string }) => {
  "use workflow";

  const [[research], [review]] = await Promise.all([
    agent("Research this: " + input.issueDescription),
    reviewer("Review this: " + input.issueDescription, { outputSchema: ReviewSchema }),
  ]);

  if (review.successful) return { successful: true, research };
  return { successful: false };
});
```

Both examples start research and review independently. To review the research
itself, await `agent(...)` first and pass its output to `reviewer(...)`.

### Results and continuation

Both `agent` and named bindings accept `prompt` plus optional `outputSchema` and
`agentId`. Without a schema, the result is `[string, metadata]`. With a schema, the
first tuple element is the validated output value, with its TypeScript type inferred
from that schema. `review.successful` above is therefore reviewer-authored structured
output. Execution failures reject the promise.

The proposed metadata starts with `{ agentId: string }`. Prefer `agentId` over
`sessionId` to match the existing continuation input: eve distinguishes the
[child identity from its session address][child-identity-from-its-session-address].

```ts
import { agent } from "eve/workflow";
import { z } from "zod";

const OutputSchema = z.object({ successful: z.boolean(), reason: z.string() });

// Inside a workflow body:
const [research, metadata] = await agent("Research the proposed change.");
const [assessment] = await agent("Assess the change using your research.", {
  agentId: metadata.agentId,
  outputSchema: OutputSchema,
});
```

Omitting `agentId` starts a fresh child. Supplying the returned `agentId` to the same
binding continues that child's session with its existing history. The schema applies
to the requested response; a follow-up can choose a different schema or plain text.
Each follow-up is a new invocation with its own replay identity, even though it uses
the same child. Named bindings such as `reviewer` use the same continuation contract.

eve must retain a resumable child handle after a successful invocation, including
when the enclosing workflow tool runs in the background. The handle belongs to the
owning session. Completing an invocation does not, by itself, end the child session.

## Current behavior and the gap

[`eve/workflow`][eve-workflow] exports `agent` and
`ask`, with no application-specific named exports. Its current delegation API is:

```ts
const review = await agent(ctx, {
  key: "review",
  target: "reviewer",
  message: "Review this: " + input.issueDescription,
});
```

The [implementation][implementation]
derives the invocation ID from `ctx.callId` and `key`, returns the child's output,
and throws on an error result. It already accepts per-call `outputSchema` and
`agentId`, but returns only output. It rejects duplicate keys within a run. The
proposal adds callable named targets, inferred structured output types, and returned
continuation metadata, while removing authored replay keys for ordinary calls.

The helper also requires an
[attached workflow tool context][attached-workflow-tool-context].
It asks the owning session to perform delegation; the session holds authorization,
capabilities, admission state, and child handles. Starting a workflow without an
existing agent session therefore needs an ownership contract before the shorthand
can work there. Discovering its source file is insufficient: the
[workflow scanner][workflow-scanner]
already scans the application root for workflow directives.

Current [agent exports][agent-exports] use `defineAgent` for
both root agents and local subagents. Single-file subagents are already
[discovered][discovered], and the compiler
[requires a description][requires-a-description].
The binding feature does not inherently require a new definition helper.

## Required semantics

These are requirements for the proposal, not claims about an implementation.

- **Names and scope.** Generated exports represent only named subagents, not
  arbitrary tools or agent sessions created at runtime. `reviewer` resolves to a
  declared subagent in the invoking agent's scope. Generated declarations and
  runtime resolution must agree on the
  selected subagent. Missing imports fail with an actionable build error; an import
  never grants access to a subagent unavailable to the invocation's owner. Reject
  binding names that conflict with existing exports such as `agent` or `ask`, or
  cannot be imported as identifiers, with a diagnostic naming the declaration.
- **Self-delegation.** `agent` preserves the built-in tool's self-delegation target
  and root-only availability. Generated bindings address named subagents separately.
- **Invocation identity.** Two calls to `reviewer`, including calls from the same
  loop or helper or with the same `agentId`, represent distinct invocations.
  Replaying either call resumes its original invocation. eve must supply identities
  without a process-global
  counter or requiring an authored `key` for the examples above.
- **Awaiting.** A binding returns a promise for `[output, metadata]`, so
  `Promise.all` can compose calls. Whether the enclosing tool is blocking or
  background does not turn the binding's result into a background-task receipt.
- **Execution ownership.** In a workflow tool, the existing owning session remains
  responsible for authorization, child handles, human-input routing, usage, and
  cancellation. The binding must use that authority rather than start a separate
  unowned agent loop. Starting a workflow outside an agent's execution must define
  equivalent ownership if that entry path is supported.
- **Runtime placement.** Generated code binds names to eve runtime functions. Agent
  execution and lifecycle behavior remain in the `eve` package.

## Decisions to settle

1. **How is `workflows/orchestration.ts` started?** If an agent calls it within its
   execution, that session provides the ownership described above. If a route or
   cron starts it without an existing agent session, specify how eve establishes
   agent scope, authorization, child handles, and a destination for human input.
2. **Are new definition helpers needed?** `defineSubagent` is absent from the
   current exports; `defineAgent` already defines local subagents. `defineWorkflow`
   is also absent, while plain functions with `"use workflow"` already have a
   discovery path. Prefer retaining existing helpers unless a new helper owns
   necessary semantics, such as establishing ownership when starting a workflow.
3. **Does the explicit helper remain?** The proposed `agent(prompt, options)` is
   strictly self-delegation. Decide whether the current target-selecting
   `agent(ctx, input)` is removed or moved to a separate API; it should not give the
   self-delegation binding a second target-selection meaning.
4. **What happens to an invalid continuation?** Preserve existing busy-child and
   target-mismatch checks. Decide whether an unknown or expired `agentId` rejects
   or retains the [current fallback to a fresh child][current-fallback-to-a-fresh-child].
   Rejection would make an
   explicit request to resume fail visibly instead of silently losing history.

## Acceptance criteria

- Compile a fixture with `reviewer.ts`, import `reviewer` from `eve/workflow`, and
  verify its model and configuration are selected. Exercise both a workflow tool
  and an authored workflow function. Cover starting outside an agent session if
  that entry path is included.
- Run parallel calls, repeated calls to one binding, and calls through a shared
  helper. Resume the workflow after suspension and verify each invocation retains
  its identity without starting duplicate children.
- Verify a typed structured result supports a branch such as
  `if (review.successful)`, and distinguish a negative review from execution failure.
- Verify no schema yields a string and schema input determines the output type.
  Resume with returned `metadata.agentId`, verify history is retained, and request
  a different output schema on the follow-up. Cover blocking and background
  workflow tools, busy or mismatched children, and expired handles.
- Verify child failure, human-input suspension, cancellation, and owner shutdown.
  Define sibling behavior when one parallel call fails; a rejected aggregate
  promise must not be treated as evidence that sibling work was cancelled.
- Reject missing, ambiguous, and out-of-scope bindings. Cover reserved names,
  disabled targets, and confirm arbitrary tools receive no generated bindings.

Use compiler/scenario coverage for generated imports and fixture-owned CI evals for
the runtime paths. This draft adds no runtime implementation or published API docs.

[tools-as-workflows]: ./tools-as-workflows.md
[agent-tool]: ../packages/eve/src/tools/framework/agent.ts#L25
[child-identity-from-its-session-address]: ../packages/eve/src/subagents/handles/store.ts#L16
[eve-workflow]: ../packages/eve/src/public/workflow/index.ts
[implementation]: ../packages/eve/src/execution/tools/subagent/invoke-agent.ts#L68
[attached-workflow-tool-context]: ../packages/eve/src/execution/tools/workflow/ask.ts#L40
[workflow-scanner]: ../packages/eve/src/internal/workflow-bundle/authored-workflow-modules.ts#L45
[agent-exports]: ../packages/eve/src/public/index.ts
[discovered]: ../packages/eve/src/discover/discover-subagent.ts#L119
[requires-a-description]: ../packages/eve/src/compiler/normalize-manifest-helpers.ts#L107
[current-fallback-to-a-fresh-child]: ../docs/subagents/index.mdx#agent-messaging
