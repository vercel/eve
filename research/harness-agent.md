---
issue: TBD
status: proposed
last_updated: "2026-08-17"
---

# AI SDK HarnessAgent subagents

## Decision

Add `@eve/harness-agent`, a first-party package that turns an AI SDK 7
`HarnessAgent` into a declared eve subagent through `defineHarnessAgent`.

A HarnessAgent subagent remains a filesystem-native eve subagent. It supports
the same static package layout as a subagent defined with `defineAgent`:

```text
agent/subagents/coder/
├── agent.ts
├── instructions.md
├── tools/
├── connections/
├── skills/
├── hooks/
├── extensions/
└── sandbox/
```

eve discovers, compiles, and owns every entry in this tree. Only the turn
implementation changes: `agent.ts` selects HarnessAgent while the surrounding
files keep their existing eve definitions and semantics. Authors do not need a
second tool format, skill format, hook system, connection layer, or sandbox
configuration for HarnessAgent.

Implement the integration as an alternate factory for eve's existing
`StepFn`, not as a second subagent runtime protocol. The compiler selects the
factory for a HarnessAgent subagent; the existing durable turn workflow still
creates the child session, enters the eve context, invokes a `StepFn`, commits
the returned `HarnessSession`, and dispatches the next action.

One HarnessAgent turn is one eve durable step. HarnessAgent owns its native
runtime and internal tool loop inside that step. eve owns capability discovery,
the child session, callback context, cancellation, event delivery, hooks,
sandbox leasing, and the step boundary. HarnessAgent session state remains
opaque package state.

This boundary avoids three duplicate systems:

- no HarnessAgent-specific session lifecycle in `eve`;
- no second tool, approval, hook, or stream pipeline in the package;
- no attempt to represent HarnessAgent as a `LanguageModel` inside eve's model
  loop.

## Authoring API

The default creates an isolated eve sandbox for the subagent, using its normal
`sandbox.ts` and `sandbox/workspace/` configuration:

```ts
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { defineHarnessAgent } from "@eve/harness-agent";
import { harness } from "../../../lib/harness";

export default defineHarnessAgent({
  createAgent: (settings) => new HarnessAgent({ harness, ...settings }),
  description: "Inspect and change the application with a coding harness.",
});
```

Set `sandbox: "parent"` to use the delegating eve session's sandbox and
filesystem:

```ts
export default defineHarnessAgent({
  createAgent: (settings) => new HarnessAgent({ harness, ...settings }),
  description: "Work in the same filesystem as the parent eve agent.",
  sandbox: "parent",
});
```

The public definition is intentionally small:

```ts
interface HarnessAgentDefinition {
  createAgent: (settings: EveHarnessAgentSettings) => HarnessAgent | Promise<HarnessAgent>;
  description: string;
  sandbox?: "subagent" | "parent";
}

interface EveHarnessAgentSettings {
  instructions?: string;
  sandbox: HarnessV1SandboxProvider;
  skills?: readonly HarnessAgentSkill[];
  toolApproval?: ToolApprovalConfiguration;
  tools: ToolSet;
}
```

`subagent` is the default, matching ordinary declared-subagent isolation. The
compiler derives the name from the path and accepts `defineHarnessAgent` only
from `subagents/<name>/agent.ts`.

The current canary stores tools, skills, instructions, and sandbox as private
immutable HarnessAgent constructor settings. A factory is therefore required
to inject eve's resolved capabilities without reading private fields. A direct
`agent: HarnessAgent` overload may be added if HarnessAgent gains a public
clone-with-overrides API; the package must not emulate one.

## Existing eve boundary

`StepFn` is already the contract between the durable execution layer and an
agent turn:

```ts
type StepFn = (session: HarnessSession, input?: StepInput) => Promise<StepResult>;
```

Add a versioned internal `AgentStepFactory` that constructs this existing
function for a resolved node. Its input contains values already owned or
prepared by eve:

```ts
interface AgentStepFactoryInput {
  abortSignal?: AbortSignal;
  handleEvent: HandleEventFn;
  instructions: ResolvedAgentInstructions;
  mode: RunMode;
  sandbox: SandboxLease;
  skills: readonly ResolvedSkillDefinition[];
  toolApproval: ToolApprovalConfiguration;
  tools: ToolSet;
}

type AgentStepFactory = (input: AgentStepFactoryInput) => StepFn | Promise<StepFn>;
```

The exact input may reuse narrower existing types, but it must not expose
`HarnessAgent`, `HarnessV1*`, or package-owned state. The default eve harness
and `@eve/harness-agent` are two consumers of the same step and context
lifecycle:

```text
durable turn workflow
        |
        v
eve context, tools, approvals, hooks, sandbox lease
        |
        v
selected AgentStepFactory
        |
        +-- default eve tool-loop StepFn
        |
        +-- @eve/harness-agent StepFn
```

The compiled subagent node needs only a tagged step-factory module source and
contract version beside its existing compiled resources. It does not contain
HarnessAgent settings or lifecycle state. Resolving an ordinary agent follows
the unchanged default branch.

## Reuse instead of translation

Move the minimum existing helpers behind an internal adapter entrypoint rather
than copying their behavior into `@eve/harness-agent`:

- Build the AI SDK `ToolSet` with eve's existing authored-tool wrappers, so
  path-derived names, schemas, `toModelOutput`, async results, auth scopes,
  connection access, state, and sandbox-aware execution remain unchanged.
- Build tool approval with eve's existing approval evaluator. The package does
  not interpret eve `Approval` definitions.
- Feed AI SDK `TextStreamPart` values through one shared stream consumer that
  owns eve protocol events, usage projection, hook dispatch, and cancellation
  behavior. Refactor this consumer from the current tool loop without changing
  default-harness output.
- Acquire the sandbox through one eve-owned `SandboxLease`. The lease hides
  backend state, graph-node ownership, resume, and release behavior while
  exposing the file, process, and optional network capabilities an adapter may
  use.

`@eve/harness-agent` performs only HarnessAgent-specific work: convert resolved
skills to `HarnessAgentSkill`, adapt the sandbox lease structurally to a
`HarnessV1SandboxProvider`, create or resume a `HarnessAgentSession`, call
`stream`, and persist the returned HarnessAgent checkpoint as opaque JSON.

## Filesystem capabilities

The filesystem entries shown in the opening use eve's existing discovery and
compilation pipeline:

- Static system instructions become HarnessAgent `instructions`. Static user
  instructions precede the first delegated message in eve's established
  order. The default eve model-loop prompt is not added.
- Authored and extension-contributed tools use the `ToolSet` prepared by eve.
  Framework tools and delegation tools are not injected into HarnessAgent.
- Skills map to `{ name, description, content, files }`. `content` is the skill
  markdown, and UTF-8 package files become HarnessAgent skill files.
- Connections remain available through authored tool callback context. No
  credential is copied into the harness process or sandbox.
- Translated AI SDK stream events pass through the node's existing hooks.
- In `subagent` sandbox mode, authored bootstrap and workspace seeds apply
  normally. In `parent` mode, authoring a child `sandbox.ts` or
  `sandbox/workspace/` is a build error because the parent owns that slot.

Dynamic instructions, tools, and skills are deferred. Supporting them requires
a defined rule for changing HarnessAgent constructor settings across a resumed
native session; the first release does not freeze or silently ignore dynamic
results.

## Tool approval prerequisite

The current HarnessAgent canary accepts a per-tool status record, while eve's
approval policy is an input-aware AI SDK `ToolApprovalConfiguration` callback.
Do not add a second approval evaluator to `@eve/harness-agent`.

Before approved eve tools ship through this integration, HarnessAgent must
accept the standard callback form or an equivalent tool-level approval
function. Then eve can pass its existing prepared approval configuration
unchanged. Until that upstream capability exists, the compiler rejects an eve
tool with `approval` inside a HarnessAgent subagent. Tools without approval and
HarnessAgent built-in tools remain supported; built-in permissions continue to
use the HarnessAgent `permissionMode` supplied by `createAgent`.

## Sandbox lease

`SandboxLease` is the only new sandbox abstraction. It represents a live eve
sandbox already selected and opened by the context provider. It carries:

- the existing eve file, process, path, and network-policy operations;
- its stable ID and default working directory;
- optional exposed ports and port URL resolution;
- ownership metadata used internally by eve when the lease closes.

The package adapts a lease to `HarnessV1NetworkSandboxSession`. Harness-facing
`stop()` and `destroy()` release only the HarnessAgent runtime view; eve closes
the underlying lease at its existing child-session boundary. In `parent` mode,
the lease points to the delegating node's sandbox and can never stop or destroy
that parent resource.

The first release supports bridge-backed harnesses only when the selected eve
sandbox exposes the required network and port capabilities. Vercel Sandbox is
the initial supported backend. A host-runtime harness that needs only file and
process operations may use another backend when its adapter does not request a
port. Missing capabilities fail before HarnessAgent starts.

## Session semantics and durability boundary

Use the eve child session ID as the HarnessAgent session ID. Store validated
`HarnessAgentResumeSessionState` under one package-owned key in the existing
eve session state map. The `eve` package treats the value as opaque JSON and
never imports its type.

For a one-shot subagent, create the HarnessAgent session, stream one turn,
consume its result, and destroy it before the `StepFn` completes. With
`experimental.subagentPersistentSessions`, call `stop()` after a settled turn,
persist `resumeFrom`, park the eve child, and create the next live HarnessAgent
session from that state when the parent sends `agentId` again. Cancellation
aborts the stream and then performs the same mode-appropriate cleanup.

HarnessAgent host tools execute inside the surrounding eve step. They retain
eve callback context, auth, connections, approvals when supported, and event
visibility, but each tool call is not an independent durable eve step. A
process failure may replay non-idempotent harness work performed since the
turn began. The package README and subagent documentation must state this
boundary.

Do not call `suspendTurn()` after every HarnessAgent tool result in the first
release. Doing so would require the package to reproduce eve's tool-loop,
approval, and commit state machine. A future checkpointing design may use
HarnessAgent's continuation API behind the same `StepFn` interface without
changing the compiler or authoring API.

## Initial scope

The first release supports static instructions, tools without eve approval,
text skills, connections used by authored tools, hooks, extensions, both
sandbox modes, cancellation, usage when reported, one-shot children, and
persistent child sessions.

It does not support:

- root-agent use of `defineHarnessAgent`;
- dynamic instructions, tools, or skills;
- nested local or remote eve subagents;
- binary skill package files;
- per-call structured `outputSchema`;
- eve-approved tools until HarnessAgent accepts the standard callback form;
- per-tool eve durability inside a HarnessAgent turn.

Unsupported capabilities fail during compilation when discoverable and before
the harness starts otherwise. Missing usage remains unavailable; the package
does not invent zero usage or claim enforcement of a limit it cannot measure.

## Package and canary policy

Create `packages/eve-harness-agent` and publish it as `@eve/harness-agent`,
following the package layout of `@eve/buzz-acp-adapter`.

The initial compatibility baseline is:

- `ai@7.0.0-canary.176`
- `@ai-sdk/harness@1.0.0-canary.13`

`@ai-sdk/harness@1.0.0-canary.13` depends on that exact AI SDK canary. Keep it
as an exact peer and development dependency so the application and package use
one HarnessAgent contract. This does not change the AI SDK version used
internally by `eve`. Recheck the pair before implementation and release; do
not publish an open `canary` range.

Depend on `eve` through `workspace:^` and validate the internal step-factory
contract version when the definition loads. Both published packages receive
patch changesets for the additive release.

## Sustainable integration testing

The required integration suite must run without model-provider credentials, a
hosted sandbox, or a live external coding harness. It executes the real pinned
`ai` and `@ai-sdk/harness` packages and replaces only external harness transport
and sandbox infrastructure with deterministic contract implementations. This
keeps normal CI reliable while still detecting changes in the HarnessAgent API
and runtime behavior.

| Layer               | Real boundary under test                                                                                 | Deterministic substitute                                             | Required coverage                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Package unit        | `@eve/harness-agent` conversion and lifecycle helpers                                                    | Plain fixtures                                                       | Skill conversion, checkpoint validation, sandbox adaptation, ownership, and cleanup                                                     |
| Package integration | Real `HarnessAgent` from the exact canary and the complete adapter `StepFn`                              | Scripted harness transport and an in-memory `SandboxLease`           | Text turns, authored tool calls, tool errors, usage, cancellation, stop, destroy, and resume                                            |
| eve integration     | Real compiler, manifest, module map, context providers, `createExecutionNodeStep`, and durable turn step | Scripted harness transport and test sandbox backend                  | Filesystem discovery, factory selection, callback context, connections, hooks, event order, state commit, and unchanged ordinary agents |
| Scenario            | Built `eve` and `@eve/harness-agent` packages in a real subprocess                                       | Local deterministic harness and sandbox implementations              | One-shot and persistent children, both sandbox modes, cancellation, and restart between settled turns                                   |
| E2E                 | A fixture agent booted and invoked through eve's public server surface                                   | Existing mock-model world and a self-contained deterministic harness | The parent delegates to the HarnessAgent subagent and receives its final result                                                         |

The scripted harness is test infrastructure owned by `@eve/harness-agent`. It
implements the exported harness contract and consumes explicit scripts for
assistant text, tool calls and results, failure, cancellation, and resumable
checkpoints. The compiler type-checks it against the pinned canary, so an
upstream contract change fails at compile time. Integration assertions target
eve events and committed state, not raw HarnessAgent event snapshots that may
change without affecting the adapter contract.

Do not mock the step-factory boundary in eve integration tests. Compile a
fixture subagent through the normal discovery and module-map path, then invoke
the selected factory through the durable turn step. Reuse one fixture matrix
across isolated and parent sandbox modes; assert resource ownership separately
so borrowed parent sandboxes can never be released by the child.

Canary updates happen only in explicit dependency-update changes. Each update
replaces the single exact-version baseline and must pass the type probe, package
integration suite, eve integration suite, and scenarios before the pin moves.
Normal PRs do not float across canaries or require a version matrix. An optional
credentialed smoke test may exercise a real harness service, but it is not the
only test for any merge-blocking behavior.

## Invariants

- Both agent implementations satisfy the existing eve `StepFn` contract.
- `eve` never imports HarnessAgent or interprets HarnessAgent session state.
- `@eve/harness-agent` never evaluates eve approval policy or dispatches eve
  hooks itself.
- Tools, context, events, and sandbox ownership have one eve implementation.
- Live HarnessAgent sessions and sandbox leases never enter durable state.
- A parent sandbox lease cannot stop or destroy the parent sandbox.
- Ordinary agents stay on the unchanged default step factory.
- Per-tool durability is not implied by running a HarnessAgent turn in an eve
  durable step.

## Implementation plan

1. **Confirm the upstream contract.** Recheck the exact compatible `ai` and
   `@ai-sdk/harness` canaries before implementation. Build a minimal type-level
   probe for constructor settings, `HarnessAgentSession.stream()`, checkpoint
   resume, sandbox provider operations, stream parts, and usage. Confirm whether
   HarnessAgent accepts AI SDK's callback-form `ToolApprovalConfiguration`; if
   it does not, keep approved eve tools behind the compilation error described
   above.
2. **Add the package and authored definition.** Create
   `packages/eve-harness-agent` with the repository's standard TypeScript,
   build, test, packing, and publication setup. Implement `defineHarnessAgent`
   as a tagged authored definition with `createAgent`, `description`, and
   `sandbox`; derive the subagent name from its path. Pin the canary peers
   exactly and export no eve runtime internals from the package's public entry.
3. **Compile the existing filesystem surface.** Extend subagent normalization,
   the compiled manifest schema, and the module map to recognize the tagged
   definition and retain its factory module source. Compile `instructions.md`,
   `tools/`, `connections/`, `skills/`, `hooks/`, `extensions/`, and `sandbox/`
   through the existing resource compilers. Add compilation errors for root
   use, dynamic resources, nested subagents, unsupported skill files, and a
   child sandbox configuration combined with `sandbox: "parent"`.
4. **Introduce the shared step-factory seam.** Refactor
   `createExecutionNodeStep` to select a versioned `AgentStepFactory` after eve
   has created the context and resolved the runtime node. Keep
   `createToolLoopHarness` as the default factory. Expose the narrow factory
   contract through a versioned internal eve entrypoint intended for first-party
   integration packages, and reject an unknown contract version before a turn
   starts. Snapshot the ordinary-agent manifest and add execution tests proving
   the default branch is unchanged.
5. **Extract reusable runtime services.** Reuse `createNodeHarnessTools`,
   `buildToolSet`, and `buildToolApproval` to prepare authored and
   extension-contributed tools without framework or delegation tools. Extract
   the smallest stream-event consumer needed to preserve eve protocol events,
   hook dispatch, usage, and cancellation. Add `SandboxLease` as a narrow view
   over the sandbox access already created by the context provider, with
   explicit borrowed-parent versus owned-child cleanup semantics. Keep auth,
   callback context, approval evaluation, hook dispatch, and sandbox ownership
   in eve.
6. **Implement the HarnessAgent step.** In `@eve/harness-agent`, convert resolved
   eve skills to `HarnessAgentSkill`, adapt `SandboxLease` to the harness sandbox
   interface, call `createAgent` with the prepared static capabilities, and
   create or resume the native HarnessAgent session. Stream one turn through
   eve's event consumer, return the existing `StepResult`, store only the
   validated opaque checkpoint in `HarnessSession.state`, and apply one-shot,
   persistent, and cancellation cleanup without releasing a borrowed parent
   sandbox.
7. **Build and enforce the test matrix.** Implement every layer in the
   sustainable integration testing section. Keep the scripted harness in the
   adapter package, share scenario descriptors rather than committed fixture
   trees, and add the self-contained e2e eval to the matching fixture. Make the
   package and eve integration suites required for ordinary changes to either
   side of the adapter contract; require scenarios when that contract, sandbox
   ownership, or resume behavior changes.
8. **Document and release.** Finish the package README, eve subagent docs,
   exact-peer packing check, and patch changesets. Run formatting, lint,
   typecheck, targeted unit and integration tests, the scenario suite, package
   packing, `pnpm guard:invariants`, and `pnpm docs:check` before release.
