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
Only named subagents receive generated bindings, including named remote subagents.
The proposed `agent(prompt)` calls
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

## Example: a software factory

A factory can put implementation, parallel review, and bounded repair in a workflow
tool using the proposed bindings. The model handling the issue calls this tool once;
workflow code decides which specialists run next and passes their structured results
between stages.

Declare `implementer`, `reviewer`, and `securityReviewer` under `agent/subagents/`.
Give the implementer repository-write tools and an isolated worktree for each issue.
Give the reviewers read access to commits and diffs. Those capabilities belong in
the subagent definitions; importing a binding does not provide them. The implementer
must publish its commit to a repository or artifact store the reviewers can read.

```ts
// agent/tools/build-issue.ts
import { defineTool } from "eve/tools";
import { implementer, reviewer, securityReviewer } from "eve/workflow";
import { z } from "zod";

const CommitSha = z.string().regex(/^[0-9a-f]{40}$/);
const Change = z.object({ commitSha: CommitSha, summary: z.string() });
const Review = z.object({
  commitSha: CommitSha,
  approved: z.boolean(),
  findings: z.array(z.string()),
});

export default defineTool({
  description: "Implement an issue and review the resulting commit.",
  execution: "background",
  inputSchema: z.object({ repository: z.string(), issue: z.string() }),
  async execute(input) {
    "use workflow";

    let [change, implementation] = await implementer(
      JSON.stringify({ task: "Implement this issue and publish a commit.", ...input }),
      { outputSchema: Change },
    );
    let repairsRemaining = 2;

    while (true) {
      const request = JSON.stringify({
        task: "Review this exact commit without modifying it.",
        repository: input.repository,
        issue: input.issue,
        commitSha: change.commitSha,
      });
      const [[review], [security]] = await Promise.all([
        reviewer(request, { outputSchema: Review }),
        securityReviewer(request, { outputSchema: Review }),
      ]);

      if ([review, security].some((result) => result.commitSha !== change.commitSha)) {
        throw new Error("A review returned a different commit than the one requested.");
      }
      if (review.approved && security.approved) {
        return { status: "reviewed", ...change, review, security };
      }
      if (repairsRemaining === 0) {
        return { status: "needs_changes", ...change, review, security };
      }

      [change] = await implementer(
        JSON.stringify({
          task: "Address these findings and publish the revised commit.",
          commitSha: change.commitSha,
          findings: [...review.findings, ...security.findings],
        }),
        { agentId: implementation.agentId, outputSchema: Change },
      );
      repairsRemaining--;
    }
  },
});
```

The implementer retains its session across repairs. Each review call starts a fresh
child. The workflow sends both reviewers the same immutable commit reference and
rejects a different returned reference. The loop permits at most two repair
invocations and three review rounds. On exhaustion it returns the last commit and
findings. Execution errors reject the workflow instead of being treated as negative
reviews.

`execution: "background"` lets the owning agent continue while the factory tool
runs, following the [existing workflow-tool contract][workflow-tool-background].
Inside the tool, each binding still waits for its result. A schema validates the
shape of a review, not whether its conclusions are correct: `reviewed` here means
both reviewers approved that commit. A merge step must separately check actual CI
results and that the pull request still points to the reviewed commit. Admission
across multiple issues also needs an application concurrency limit; `Promise.all`
only expresses the two reviews within one issue.

## Example: remote specialists

A named remote subagent receives the same proposed binding as a local one. To run
the factory's security review in another deployment, define its existing name with
the current [`defineRemoteAgent` API][remote-definition]:

```ts
// agent/subagents/securityReviewer.ts in the factory application
import { defineRemoteAgent } from "eve";
import { vercelOidc } from "eve/agents/auth";

export default defineRemoteAgent({
  description: "Review an exact repository commit for security issues.",
  url: "https://security-reviewer.example.com",
  auth: vercelOidc(),
});
```

The factory's `securityReviewer(request, { outputSchema: Review })` call stays the
same. The URL and outbound authentication belong to the declaration. The receiver
must authorize the calling deployment using the [existing remote auth setup][remote-auth].
If it needs to act as the parent's end user, configure `forwardPrincipal: true` and
the receiver's trusted forwarders as described in [identity forwarding][remote-principal].
The import does not transfer repository credentials or make local files available
remotely; the receiver needs its own access to the referenced commit.

The result and continuation contract also stays the same:

```ts
// Inside the factory's workflow body; Review is the schema above.
const [review, securityMetadata] = await securityReviewer(request, {
  outputSchema: Review,
});
const [clarification] = await securityReviewer("Explain the first finding in more detail.", {
  agentId: securityMetadata.agentId,
});
```

The returned `agentId` belongs to the factory's child-handle store. eve uses that
handle's [remote session address][remote-session-address] to continue the same
session on the receiver. The workflow does not construct HTTP requests or pass a
remote `sessionId`. Existing [remote dispatch][remote-dispatch] already sends a
message and output schema with a callback, and supports
[continuation requests][remote-continuation]. The proposal makes those operations
available through named calls that resolve to `[output, metadata]`, preserving
remote failure, human-input, cancellation, and cleanup behavior.

### Inside the remote specialist

The receiving agent can itself use named bindings in its workflow tools. For
example, the security-reviewer application could declare `dependencyReviewer` and
`codeReviewer` under its own `agent/subagents/` and combine their results:

```ts
// agent/tools/review-commit.ts in the security-reviewer application
import { defineTool } from "eve/tools";
import { codeReviewer, dependencyReviewer } from "eve/workflow";
import { z } from "zod";

const Finding = z.object({ findings: z.array(z.string()) });

export default defineTool({
  description: "Inspect a commit's code and dependencies in parallel.",
  inputSchema: z.object({ repository: z.string(), commitSha: z.string() }),
  async execute(input) {
    "use workflow";

    const request = JSON.stringify(input);
    const [[code], [dependencies]] = await Promise.all([
      codeReviewer(request, { outputSchema: Finding }),
      dependencyReviewer(request, { outputSchema: Finding }),
    ]);
    return { commitSha: input.commitSha, findings: [...code.findings, ...dependencies.findings] };
  },
});
```

These imports resolve against the receiving application's agent scope. Its session
owns these children; their handles are not continuation handles for the factory.
Being invoked remotely does not add the caller's bindings to that scope or change
the root-only rule for `agent`. The remote agent uses its tool result to produce
the final response required by the factory's `Review` schema.

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
- **Remote parity.** A named `defineRemoteAgent` declaration produces the same
  callable binding and continuation metadata as a local declaration. Dispatch uses
  its configured endpoint and auth, and `agentId` resolves through the owning
  session's handle store. A receiving agent may use its own named bindings under
  the same scope and lifecycle rules.
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
5. **How do remote schema defaults affect the return type?** Remote definitions
   already allow a default `outputSchema` for new sessions. Decide whether a call
   without an explicit schema infers that default or the binding API requires
   per-call schemas. The remote examples above omit a declaration-level default;
   their calls follow the string-or-explicit-schema contract.

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
- Run the factory with a local security reviewer and with a remote one. Verify
  identical tuple shapes, schema validation, continuation history, and repair
  limits. Reject reviews of a different commit and return the final findings when
  repairs are exhausted.
- Exercise a remote specialist calling its own named subagents. Verify the factory
  cannot use the specialist's child handles, and cover remote authorization
  rejection, human-input routing, cancellation, and owner cleanup.

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
[workflow-tool-background]: ../research/tools-as-workflows.md#wait-or-run-in-the-background
[remote-auth]: ../docs/guides/remote-agents.md#outbound-auth
[remote-principal]: ../docs/guides/remote-agents.md#forwarding-the-caller-identity
[remote-session-address]: ../packages/eve/src/subagents/handles/store.ts#L87
[remote-dispatch]: ../packages/eve/src/subagents/remote-dispatch.ts#L56
[remote-continuation]: ../packages/eve/src/subagents/remote-dispatch.ts#L201
[remote-definition]: ../packages/eve/src/public/definitions/remote-agent.ts#L83
