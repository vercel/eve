---
issue: TBD
status: draft
last_updated: "2026-09-04"
---

# Named subagents on workflow tool context

Expose self-delegation as `ctx.agent(prompt, options)` and declared subagents as
`ctx.subagent[name](prompt, options)` on the context supplied by `defineWorkflowTool`.

`ctx.subagent.reviewer` and `ctx.subagent["reviewer"]` address the same declared
subagent. The context supplies the owning session; eve supplies replay-stable
invocation identities. This extends the current
[`defineWorkflowTool` contract][workflow-tool-context], whose `ctx.agent` still takes
an explicit target and replay key and returns only output.

`defineWorkflow` and workflows started without an owning agent session are deferred
to a separate change.

## Proposed authoring API

The callable subagent properties, shorthand `ctx.agent`, and tuple results below
are proposed. `defineWorkflowTool` and its `execute(input, ctx)` signature already
exist. `defineSubagent` retains the name from the initial sketch; its inclusion is
an open API decision below.

```ts
// agent/subagents/reviewer.ts
import { defineSubagent } from "eve";

export default defineSubagent({
  description: "Review an issue and report whether the review passes.",
  model: "openai/gpt-5.6-sol",
});
```

The filename supplies the `reviewer` key in `ctx.subagent`; no separate name or
registration is authored. Only named subagents receive entries, including named
remote subagents. The proposed `ctx.agent(prompt)` delegates to a copy of itself,
matching the built-in [`agent` tool][agent-tool]'s target and root-only availability.
Named targets are selected through `ctx.subagent`.

Reading a binding from `ctx` does not start an agent. Calling it starts a new child or
continues the child identified by `agentId`; awaiting it returns `[output, metadata]`
after that invocation completes.

```ts
// agent/tools/orchestration.ts
import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

const ReviewSchema = z.object({ successful: z.boolean() });

export default defineWorkflowTool({
  description: "Research and review an issue in parallel.",
  inputSchema: z.object({ issueDescription: z.string() }),
  async execute(input, ctx) {
    "use workflow";

    const [[research], [review]] = await Promise.all([
      ctx.agent("Research this: " + input.issueDescription),
      ctx.subagent.reviewer("Review this: " + input.issueDescription, {
        outputSchema: ReviewSchema,
      }),
    ]);

    if (review.successful) return { successful: true, research };
    return { successful: false };
  },
});
```

This example starts research and review independently. To review the research
itself, await `ctx.agent(...)` first and pass its output to `ctx.subagent.reviewer(...)`.

### Choose a subagent by name

Bracket access supports names selected by application code and names that cannot be
written with dot access. A shared helper receives the workflow tool's context:

```ts
import type { WorkflowToolContext } from "eve/tools";
import { z } from "zod";

const ReviewSchema = z.object({ successful: z.boolean() });

async function reviewWith(
  ctx: WorkflowToolContext,
  namedAgent: "reviewer" | "securityReviewer",
  prompt: string,
) {
  const [review] = await ctx.subagent[namedAgent](prompt, { outputSchema: ReviewSchema });
  return review;
}
```

The name selects a declared subagent visible to this context's owning agent. It
does not look up a global agent or an existing child session. Unknown or currently
unavailable names must fail with an actionable error before starting a child.
Bracket access preserves the path-derived name, including extension namespaces;
it does not bypass availability or authorization checks.

### Results and continuation

Both `ctx.agent` and `ctx.subagent[name]` accept `prompt` plus optional `outputSchema` and
`agentId`. Without a schema, the result is `[string, metadata]`. With a schema, the
first tuple element is the validated output value, with its TypeScript type inferred
from that schema. `review.successful` above is therefore reviewer-authored structured
output. Execution failures reject the promise.

The proposed metadata starts with `{ agentId: string }`. Prefer `agentId` over
`sessionId` to match the existing continuation input: eve distinguishes the
[child identity from its session address][child-identity-from-its-session-address].

```ts
import { z } from "zod";

const OutputSchema = z.object({ successful: z.boolean(), reason: z.string() });

// Inside a defineWorkflowTool executor with its ctx argument:
const [research, metadata] = await ctx.agent("Research the proposed change.");
const [assessment] = await ctx.agent("Assess the change using your research.", {
  agentId: metadata.agentId,
  outputSchema: OutputSchema,
});
```

Omitting `agentId` starts a fresh child. Supplying the returned `agentId` to the same
binding continues that child's session with its existing history. The schema applies
to the requested response; a follow-up can choose a different schema or plain text.
Each follow-up is a new invocation with its own replay identity, even though it uses
the same child. `ctx.subagent.reviewer` uses the same continuation contract.

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
the subagent definitions; accessing `ctx.subagent` does not provide them. The implementer
must publish its commit to a repository or artifact store the reviewers can read.

```ts
// agent/tools/build-issue.ts
import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

const CommitSha = z.string().regex(/^[0-9a-f]{40}$/);
const Change = z.object({ commitSha: CommitSha, summary: z.string() });
const Review = z.object({
  commitSha: CommitSha,
  approved: z.boolean(),
  findings: z.array(z.string()),
});

export default defineWorkflowTool({
  description: "Implement an issue and review the resulting commit.",
  execution: "background",
  inputSchema: z.object({ repository: z.string(), issue: z.string() }),
  async execute(input, ctx) {
    "use workflow";

    let [change, implementation] = await ctx.subagent.implementer(
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
        ctx.subagent.reviewer(request, { outputSchema: Review }),
        ctx.subagent.securityReviewer(request, { outputSchema: Review }),
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

      [change] = await ctx.subagent.implementer(
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

The factory's `ctx.subagent.securityReviewer(request, { outputSchema: Review })` call stays the
same. The URL and outbound authentication belong to the declaration. The receiver
must authorize the calling deployment using the [existing remote auth setup][remote-auth].
If it needs to act as the parent's end user, configure `forwardPrincipal: true` and
the receiver's trusted forwarders as described in [identity forwarding][remote-principal].
The context binding does not transfer repository credentials or make local files available
remotely; the receiver needs its own access to the referenced commit.

The result and continuation contract also stays the same:

```ts
// Inside the factory's execute(input, ctx); Review is the schema above.
const [review, securityMetadata] = await ctx.subagent.securityReviewer(request, {
  outputSchema: Review,
});
const [clarification] = await ctx.subagent.securityReviewer(
  "Explain the first finding in more detail.",
  { agentId: securityMetadata.agentId },
);
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
import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

const Finding = z.object({ findings: z.array(z.string()) });

export default defineWorkflowTool({
  description: "Inspect a commit's code and dependencies in parallel.",
  inputSchema: z.object({ repository: z.string(), commitSha: z.string() }),
  async execute(input, ctx) {
    "use workflow";

    const request = JSON.stringify(input);
    const [[code], [dependencies]] = await Promise.all([
      ctx.subagent.codeReviewer(request, { outputSchema: Finding }),
      ctx.subagent.dependencyReviewer(request, { outputSchema: Finding }),
    ]);
    return { commitSha: input.commitSha, findings: [...code.findings, ...dependencies.findings] };
  },
});
```

These context properties resolve against the receiving application's agent scope. Its session
owns these children; their handles are not continuation handles for the factory.
Being invoked remotely does not add the caller's bindings to that scope or change
the root-only rule for `ctx.agent`. The remote agent uses its tool result to produce
the final response required by the factory's `Review` schema.

## Current behavior and the gap

Current `main` exposes [`WorkflowToolContext`][workflow-tool-context] from `eve/tools`.
`defineWorkflowTool` requires a `"use workflow"` executor and supplies `ctx.agent`
and `ctx.ask`. The `eve/workflow` entry point has been removed, as documented in
the [workflow-tool migration][workflow-tool-migration]. Its current delegation API is:

```ts
const review = await ctx.agent({
  key: "review",
  target: "reviewer",
  message: "Review this: " + input.issueDescription,
});
```

The [implementation][implementation] derives the invocation ID from `ctx.callId`
and `key`, returns the child's output, and throws on an error result.
It already accepts per-call `outputSchema` and
`agentId`, but returns only output. It rejects duplicate keys within a run. The
proposal separates self-delegation from named targets, adds inferred structured
output types and returned continuation metadata, and removes authored replay keys
for ordinary calls.

The runtime already [binds helpers to the executor context][workflow-tool-body].
Delegation asks the owning session to act; the session holds authorization,
capabilities, admission state, and child handles. `ctx.subagent` extends that
existing ownership contract. Ordinary tools, channels, and schedules do not receive
this workflow context.

The proposed migration is a breaking change to `ctx.agent`: self-delegation becomes
`ctx.agent(message, options)`, and named targets become
`ctx.subagent[target](message, options)`. Callers destructure `[output, metadata]`
instead of receiving only output. The old target-selecting overload is replaced;
`ctx.ask` retains its current contract.

Current [agent exports][agent-exports] use `defineAgent` for
both root agents and local subagents. Single-file subagents are already
[discovered][discovered], and the compiler
[requires a description][requires-a-description].
The binding feature does not inherently require a new definition helper.

## Required semantics

These are requirements for the proposal, not claims about an implementation.

- **Names and scope.** `ctx.subagent` contains only declared named subagents visible
  to the invoking agent. Dot access and bracket access select the same entry.
  Name lookup must use declared entries, not inherited object properties. Unknown,
  disabled, or out-of-scope names fail before dispatch. Types and runtime lookup
  must agree on path-derived names; bracket access supports names that cannot be
  written as JavaScript identifiers. Existing subagent naming rules still apply.
  Nesting under `ctx.subagent` keeps these keys separate from `ctx.agent` and `ctx.ask`.
- **Self-delegation.** `ctx.agent` preserves the built-in tool's self-delegation
  target and root-only availability. `ctx.subagent` addresses named subagents.
- **Remote parity.** A named `defineRemoteAgent` declaration produces the same
  callable entry in `ctx.subagent` and continuation metadata as a local declaration. Dispatch uses
  its configured endpoint and auth, and `agentId` resolves through the owning
  session's handle store. A receiving agent may use its own named bindings under
  the same scope and lifecycle rules.
- **Invocation identity.** Two calls to `ctx.subagent.reviewer`, including calls from the same
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
  unowned agent loop.
- **Runtime placement.** eve creates bindings for the run's executor context.
  Any generated types describe the names; agent execution and lifecycle behavior
  remain in the `eve` package. Shared helpers use the supplied context rather than
  selecting an owner through module-level imports.

## Decisions to settle

1. **Is `defineSubagent` needed?** It is absent from the current exports;
   `defineAgent` already defines local subagents. Prefer the existing helper unless
   the new helper introduces necessary semantics.
2. **What happens to an invalid continuation?** Preserve existing busy-child and
   target-mismatch checks. Decide whether an unknown or expired `agentId` rejects
   or retains the [current fallback to a fresh child][current-fallback-to-a-fresh-child].
   Rejection would make an
   explicit request to resume fail visibly instead of silently losing history.
3. **How do remote schema defaults affect the return type?** Remote definitions
   already allow a default `outputSchema` for new sessions. Decide whether a call
   without an explicit schema infers that default or the binding API requires
   per-call schemas. The remote examples above omit a declaration-level default;
   their calls follow the string-or-explicit-schema contract.

## Acceptance criteria

- Compile a `defineWorkflowTool` fixture with `reviewer.ts` and verify
  `ctx.subagent.reviewer` and `ctx.subagent[namedAgent]` select its model and configuration.
  Verify `ctx.agent` delegates to self and cannot select another target.
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
- Reject unknown, disabled, and out-of-scope names through both access forms.
  Cover computed names, names requiring bracket access, and inherited object keys.
  Confirm arbitrary tools do not appear in `ctx.subagent`, and ordinary tool,
  channel, and schedule contexts do not expose these delegation methods.
- Run the factory with a local security reviewer and with a remote one. Verify
  identical tuple shapes, schema validation, continuation history, and repair
  limits. Reject reviews of a different commit and return the final findings when
  repairs are exhausted.
- Exercise a remote specialist calling its own named subagents. Verify the factory
  cannot use the specialist's child handles, and cover remote authorization
  rejection, human-input routing, cancellation, and owner cleanup.

Use compiler/scenario coverage for context types and name resolution, and
fixture-owned CI evals for the runtime paths. This draft adds no runtime
implementation or published API docs.

[agent-tool]: ../packages/eve/src/tools/framework/agent.ts#L25
[child-identity-from-its-session-address]: ../packages/eve/src/subagents/handles/store.ts#L16
[workflow-tool-context]: ../packages/eve/src/tools/workflow-definition.ts#L26
[workflow-tool-migration]: ../docs/tools/workflows.mdx#migrate-an-existing-workflow-tool
[workflow-tool-body]: ../packages/eve/src/execution/tools/workflow/body.ts#L128
[implementation]: ../packages/eve/src/execution/tools/subagent/invoke-agent.ts#L62
[agent-exports]: ../packages/eve/src/public/index.ts
[discovered]: ../packages/eve/src/discover/discover-subagent.ts#L119
[requires-a-description]: ../packages/eve/src/compiler/normalize-manifest-helpers.ts#L107
[current-fallback-to-a-fresh-child]: ../docs/subagents/index.mdx#agent-messaging
[workflow-tool-background]: ../docs/tools/workflows.mdx#wait-or-run-in-the-background
[remote-auth]: ../docs/guides/remote-agents.md#outbound-auth
[remote-principal]: ../docs/guides/remote-agents.md#forwarding-the-caller-identity
[remote-session-address]: ../packages/eve/src/subagents/handles/store.ts#L87
[remote-dispatch]: ../packages/eve/src/subagents/remote-dispatch.ts#L56
[remote-continuation]: ../packages/eve/src/subagents/remote-dispatch.ts#L201
[remote-definition]: ../packages/eve/src/public/definitions/remote-agent.ts#L83
