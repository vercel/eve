---
issue: TBD
status: proposed
last_updated: "2026-08-25"
---

# Agent runner layer

## Decision

Introduce a versioned `AgentRunnerV1` layer between eve's durable agent
lifecycle and the implementation that performs agent work. The existing eve
tool loop becomes the built-in runner. External packages may provide other
runners without eve importing, compiling, or branching on those packages.

An agent runner is not a new subagent protocol. eve continues to own root and
child sessions, workflow steps, task handles, callbacks, cancellation,
sandboxes, tools, hooks, auth, and protocol events. A runner owns only its
native execution state and one durable slice of agent work.

```text
authored agent node
       |
       v
eve durable session and context
       |
       v
AgentRunnerV1 host
       |
       +-- built-in eve runner
       |
       +-- external package runner
```

The contract is general. No source file in `eve` identifies HarnessAgent,
imports `@ai-sdk/harness`, understands a harness adapter, or stores
HarnessAgent settings. An external package such as `@eve/harness-agent` may use
the contract, but it remains ordinary authored application code from eve's
perspective.

## Problem

The durable workflow already funnels root agents and local subagents through a
`StepFn`, but the boundary is not implementation-neutral:

- `RuntimeTurnAgent` requires an eve model, dynamic model, or dynamic config;
- session construction and hydration store model-loop-specific agent, history,
  tool, and compaction data directly on `HarnessSession`;
- turn preparation refreshes that data before selecting the step
  implementation;
- `createExecutionNodeStep` constructs `createToolLoopHarness` directly;
- the tool loop owns protocol emission, usage, approval, input, retry,
  compaction, and background-effect behavior that a second implementation
  would otherwise have to duplicate.

Adding a second hard-coded branch would make these dependencies worse. Adding
HarnessAgent-specific compiler or manifest fields would also prevent other
agent implementations from using the same seam.

The runner layer must separate common durable lifecycle state from
implementation-owned state, while preserving the existing behavior of the
built-in eve runner.

## Scope

This proposal will:

- define one versioned, eve-owned runner contract;
- let every local runtime node select a runner, including the root node and
  declared subagents;
- adapt the existing eve tool loop to that contract without changing its
  observable behavior;
- allow an authored module to supply an external runner provider through the
  existing compiled module map;
- keep runner checkpoints opaque, namespaced, JSON-serializable, and durable;
- expose tools, sandbox access, content events, usage, and input requests
  through eve-owned host interfaces;
- keep remote agents on the existing remote eve session protocol.

This proposal does not:

- add HarnessAgent or harness adapters to `eve`;
- define a generic remote-agent wire protocol;
- make live runner objects durable;
- let packages mutate a global runner registry;
- let a runner emit raw eve protocol events or construct workflow state;
- promise that every runner supports every eve capability.

## Authoring API

`defineAgent` becomes a union over the built-in model runner and a custom
runner. `model` and `runner` are mutually exclusive.

```ts
import { defineAgent } from "eve";
import { harnessAgent } from "@eve/harness-agent";
import { claudeCode } from "@ai-sdk/harness-claude-code";

export default defineAgent({
  description: "Inspect and modify the application.",
  runner: harnessAgent({
    harness: claudeCode(),
  }),
});
```

An external package may offer a convenience definition if that produces the
same canonical agent definition:

```ts
import { defineHarnessAgent } from "@eve/harness-agent";
import { claudeCode } from "@ai-sdk/harness-claude-code";

export default defineHarnessAgent({
  description: "Inspect and modify the application.",
  harness: claudeCode(),
});
```

The generic shape is:

```ts
type AgentDefinition = AgentDefinitionBase &
  (
    | {
        model: AgentModelDefinition;
        runner?: never;
      }
    | {
        model?: never;
        runner: AgentRunnerDefinitionV1;
      }
  );
```

Model-specific siblings such as `reasoning`, `modelOptions`,
`modelContextWindowTokens`, and model compaction are invalid with a custom
runner unless a later contract gives them runner-neutral meaning. Common
settings such as `description`, session limits, and output schema remain on the
agent definition.

External packages construct a runner definition through a versioned entrypoint:

```ts
import { defineAgentRunner } from "eve/agent-runners/v1";

export const harnessAgent = (settings: HarnessAgentSettings) =>
  defineAgentRunner({
    id: "@eve/harness-agent",
    capabilities: resolveHarnessAgentCapabilities(settings),
    create(input) {
      return createHarnessAgentRunner({ input, settings });
    },
  });
```

The `v1` entrypoint fixes the contract version; authors do not supply an
arbitrary version number. `defineAgentRunner` stamps the definition with an
eve-owned marker so the compiler does not infer runner identity from object
shape or package name.

The definition and its `create` function are stateless. They may hold immutable
configuration, but they must not retain a live native session across calls.
Durable continuation uses the runner checkpoint.

## Public contract

### Definition and provider

```ts
interface AgentRunnerDefinitionV1 {
  readonly apiVersion: 1;
  readonly capabilities: AgentRunnerCapabilitiesV1;
  readonly create: AgentRunnerFactoryV1;
  readonly id: string;
  readonly kind: "agent-runner";
}

type AgentRunnerFactoryV1 = (
  input: AgentRunnerFactoryInputV1,
) => AgentRunnerV1 | Promise<AgentRunnerV1>;
```

`id` is a stable provider identity used for diagnostics, checkpoint ownership,
and resume validation. It does not select code. The compiled module source is
the only authority for loading the provider.

### Factory input

eve creates a fresh runner inside the active context scope for each durable
slice:

```ts
interface AgentRunnerFactoryInputV1 {
  readonly agent: {
    readonly id: string;
    readonly instructions: readonly AgentRunnerInstructionV1[];
    readonly skills: readonly AgentRunnerSkillV1[];
  };
  readonly sandbox: AgentRunnerSandboxHostV1;
  readonly tools: AgentRunnerToolHostV1;
}
```

The input contains only runner-neutral values and host services. It does not
expose `HarnessSession`, `StepFn`, `StepResult`, a workflow handle, a channel
adapter, or the resolved runtime graph.

Instructions and skills are immutable eve-owned projections rather than
authored definitions or AI SDK values:

```ts
interface AgentRunnerInstructionV1 {
  readonly content: string;
  readonly name: string;
  readonly role: "system" | "user";
}

interface AgentRunnerSkillV1 {
  readonly description: string;
  readonly files: readonly {
    readonly content: string;
    readonly encoding: "base64" | "utf8";
    readonly path: string;
  }[];
  readonly markdown: string;
  readonly name: string;
}
```

The host normalizes authored and dynamic skills into this shape. A runner may
translate it again into its native skill representation.

### Runner

```ts
interface AgentRunnerV1 {
  run(input: AgentRunnerRunInputV1): Promise<AgentRunnerRunResultV1>;
}

interface AgentRunnerRunInputV1 {
  readonly abortSignal?: AbortSignal;
  readonly checkpoint?: JsonValue;
  readonly emit: AgentRunnerEmitV1;
  readonly input?: AgentRunnerInputV1;
  readonly mode: "conversation" | "task";
  readonly outputSchema?: JsonObject;
  readonly sessionId: string;
}
```

Run input is also runner-neutral and durable:

```ts
interface AgentRunnerInputV1 {
  readonly content?: string | readonly AgentRunnerContentPartV1[];
  readonly context?: readonly string[];
  readonly responses?: readonly AgentRunnerInputResponseV1[];
}

type AgentRunnerContentPartV1 =
  | { readonly text: string; readonly type: "text" }
  | {
      readonly data: string;
      readonly encoding: "base64" | "url";
      readonly filename?: string;
      readonly mediaType: string;
      readonly type: "file" | "image";
    };

interface AgentRunnerInputResponseV1 {
  readonly optionId?: string;
  readonly requestId: string;
  readonly text?: string;
}
```

The host converts channel content into this representation before invoking a
runner. The runner does not receive channel-specific delivery or auth values.

One `run` call is one durable slice, not necessarily one model call or one
complete turn. The built-in eve runner may return `continue` after a model or
tool step. A native runner may complete its internal loop inside one slice and
return `waiting` or `done`.

The workflow abort signal is the sole cancellation signal. A runner must stop
native work and release runner-owned resources when it aborts. It cannot stop
or destroy an eve-owned sandbox.

### Results

```ts
type AgentRunnerRunResultV1 =
  | {
      readonly checkpoint: JsonValue;
      readonly status: "continue";
      readonly usage?: TokenUsage;
    }
  | {
      readonly checkpoint: JsonValue;
      readonly output: unknown;
      readonly status: "waiting";
      readonly usage?: TokenUsage;
    }
  | {
      readonly isError?: boolean;
      readonly output: unknown;
      readonly status: "done";
      readonly usage?: TokenUsage;
    }
  | {
      readonly checkpoint: JsonValue;
      readonly requests: readonly AgentRunnerInputRequestV1[];
      readonly status: "input-required";
      readonly usage?: TokenUsage;
    };
```

The runner may request only interaction shapes that eve knows how to park and
resume:

```ts
type AgentRunnerInputRequestV1 =
  | {
      readonly allowFreeform?: boolean;
      readonly options?: readonly {
        readonly description?: string;
        readonly id: string;
        readonly label: string;
      }[];
      readonly prompt: string;
      readonly requestId: string;
      readonly type: "question";
    }
  | {
      readonly callId: string;
      readonly input: unknown;
      readonly name: string;
      readonly requestId: string;
      readonly type: "tool-approval";
    };
```

eve maps these states onto its internal lifecycle:

| Runner status    | eve behavior                                                         |
| ---------------- | -------------------------------------------------------------------- |
| `continue`       | Commit the slice and invoke the runner again                         |
| `waiting`        | Settle the turn and park the conversation session                    |
| `done`           | Complete task mode and notify the delegating parent when one exists  |
| `input-required` | Commit the checkpoint, expose the requests, and park until responses |

The host, not the runner, produces `StepResult`, writes durable task effects,
emits session boundaries, and notifies a parent.

## Runner state and durability

The durable session stores a generic runner record:

```ts
interface DurableAgentRunnerStateV1 {
  readonly apiVersion: 1;
  readonly checkpoint?: JsonValue;
  readonly id: string;
}
```

The runtime validates JSON serializability before every commit. The checkpoint
is opaque to eve. The provider validates its shape and owns migrations within
its stable `id`; an incompatible checkpoint fails with an actionable error
rather than starting a fresh native session silently.

Live native agents, sessions, subprocess handles, streams, sandbox handles,
and closures never enter durable state. A fresh process can load the provider,
create a runner, and resume solely from the checkpoint and eve-owned session
data.

The built-in eve runner may initially adapt its existing session data into this
record rather than migrate all history in one change. The target architecture
separates the common session envelope from built-in-runner state so custom
runners do not require placeholder models, histories, or compaction settings.

## Events

Runners emit a small eve-owned semantic stream:

```ts
type AgentRunnerEventV1 =
  | { readonly type: "text.delta"; readonly text: string }
  | { readonly type: "reasoning.delta"; readonly text: string }
  | {
      readonly type: "tool.called";
      readonly callId: string;
      readonly input: unknown;
      readonly name: string;
    }
  | {
      readonly type: "tool.completed";
      readonly callId: string;
      readonly isError?: boolean;
      readonly output: unknown;
    }
  | { readonly type: "usage"; readonly usage: TokenUsage };

type AgentRunnerEmitV1 = (event: AgentRunnerEventV1) => Promise<void>;
```

The exact event union should remain minimal and derive from protocol behavior
that eve can support for every runner. It must not reuse an AI SDK stream type
as the public contract. An AI SDK-based package translates its native stream;
another implementation need not depend on AI SDK.

eve enriches runner events with session, turn, sequence, step, trace, and
audience data, then routes them through the existing stream and hook pipeline.
Runners cannot choose those identifiers or emit `session.started`,
`subagent.called`, `session.waiting`, or other control-plane events.

Host-executed tool events must be emitted exactly once. The tool host records
those events when it executes a tool; a runner emits `tool.called` and
`tool.completed` only for native tools that bypass the host.

## Tools and approvals

eve supplies runner-neutral tool definitions and host operations:

```ts
interface AgentRunnerToolDefinitionV1 {
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly name: string;
  readonly outputSchema?: JsonObject;
}

interface AgentRunnerToolHostV1 {
  readonly definitions: readonly AgentRunnerToolDefinitionV1[];

  evaluateApproval(input: {
    readonly callId: string;
    readonly name: string;
    readonly toolInput: unknown;
  }): Promise<"approved" | "denied" | "not-applicable" | "user-approval">;

  execute(input: {
    readonly abortSignal?: AbortSignal;
    readonly callId: string;
    readonly name: string;
    readonly toolInput: unknown;
  }): Promise<unknown> | AsyncIterable<unknown>;
}
```

The host wraps authored execution with eve's callback context, auth scopes,
connections, output normalization, task ownership, and event recording. The
runner converts these definitions into its native tool format and never calls
an authored execute function directly.

When `evaluateApproval` returns `user-approval`, the runner must suspend its
native turn and return `input-required` with a checkpoint. The next `run` input
carries the settled response. A provider that cannot suspend and resume this
boundary declares approval unsupported; eve rejects an incompatible authored
tool surface before execution when possible.

Background tools and subagent delegation remain host effects. The tool host
records them outside runner-owned state and returns the model-visible receipt.
Their task and child-session state never enters a runner checkpoint.

## Sandbox host

The runner borrows the sandbox selected by the node's ordinary `sandbox.ts`:

```ts
interface AgentRunnerSandboxHostV1 {
  getSession(): Promise<SandboxSession | null>;

  reservePort?(input: {
    readonly protocol: "http" | "websocket";
    readonly purpose: string;
  }): Promise<AgentRunnerPortLeaseV1>;
}

interface AgentRunnerPortLeaseV1 {
  readonly endpoint: string;
  readonly port: number;
  release(): Promise<void>;
}
```

`reservePort` is a general optional network capability. The host resolves the
backend-specific endpoint and owns the reservation. An external runner may use
the endpoint but cannot add routes, inspect backend credentials, or destroy
the sandbox.

Parent sandbox sharing stays an eve sandbox definition concern:

```ts
import { defineSandbox } from "eve";

export default defineSandbox(({ parent }) => {
  if (parent === null) throw new Error("This agent requires a parent sandbox.");
  return parent.sandbox;
});
```

Runner definitions do not add a second `sandbox: "parent"` setting.

## Capability negotiation

The runner definition declares a closed capability record that eve can inspect
at compilation and runtime:

```ts
interface AgentRunnerCapabilitiesV1 {
  readonly attachments: boolean;
  readonly dynamicInstructions: boolean;
  readonly dynamicSkills: boolean;
  readonly dynamicTools: boolean;
  readonly inputRequests: boolean;
  readonly outputSchema: boolean;
  readonly skills: boolean;
  readonly toolApproval: boolean;
  readonly tools: boolean;
}
```

These flags describe contract support, not package configuration. eve rejects
an agent node whose compiled resources require a capability that its runner
does not support. More granular capabilities require a new additive contract
field or a new API version; package-name checks are forbidden.

Dynamic instructions, tools, and skills require a defined refresh point. V1
resolves the node's effective resources before each runner slice and passes
that immutable snapshot to the factory. A runner checkpoint may not assume the
same resource snapshot on a later turn. Providers that cannot accept a changed
resource declare the corresponding dynamic capability unsupported.

## Compilation and module loading

The selected `agent.ts` module remains the executable source of a custom runner
definition. The compiler validates the generic marker, provider ID, API
version, capabilities, and agent-level settings, then stores only a generic
runner reference:

```ts
interface CompiledAgentRunnerReferenceV1 {
  readonly apiVersion: 1;
  readonly capabilities: AgentRunnerCapabilitiesV1;
  readonly id: string;
  readonly source: ModuleSourceRef;
}
```

The provider factory is not serialized. The existing compiled binding and
module map retain the authored module namespace. At runtime eve loads that
source, materializes its selected export, validates that it still matches the
compiled runner reference, and invokes `create`.

`packages/eve/src/compiler/module-map.ts` must contain no runner-provider
condition and no external-package identity. Its generated artifact naturally
imports the authored `agent.ts`, which naturally imports its external package.
This is the same module-loading relationship used by authored tools, hooks,
sandboxes, and dynamic definitions.

There is no `registerAgentRunner()` side effect. Global registration would make
build output depend on import order, hide required dependencies from the
compiled graph, and create a second source system.

## External package boundary

An external provider package depends on the versioned runner entrypoint and
owns every dependency needed by its native implementation. For an
`@eve/harness-agent` package, that includes `@ai-sdk/harness` and selected
harness adapters. `eve` neither depends on nor vendors them.

The package may expose third-party-specific configuration because that is its
own API. The eve contract contains only runner-neutral types. This avoids
forcing eve releases when the external library adds settings or adapters.

The provider is trusted application code with the same authority as an
authored tool or sandbox definition. The runner host narrows what it receives,
but it is not a security isolation boundary for an untrusted npm package.

## Root agents, subagents, and remote agents

The runner reference belongs to every compiled local agent node. The same
runtime selection therefore applies to root agents and declared subagents.
Subagent descriptions remain required because the parent needs a delegation
description; a root description remains optional.

Root and child sessions share the runner SPI but retain their existing
lifecycle differences:

- a root normally returns `waiting` after each conversational turn;
- a one-shot task subagent normally returns `done`;
- a persistent subagent may return `waiting` with a checkpoint;
- root channel delivery may contain attachments and contextual input that a
  delegated subagent message does not.

The host normalizes those differences into `AgentRunnerInputV1`. A runner that
does not support attachments or input requests fails through capability
validation rather than receiving silently degraded input.

Remote agents remain eve protocol peers selected through `defineRemoteAgent`.
They do not implement `AgentRunnerV1` in the parent process.

## Built-in eve runner

The existing eve model loop becomes the first implementation of
`AgentRunnerV1`. An internal adapter translates between `AgentRunnerRunResultV1`
and the current `StepResult` while the session state is separated.

The migration must preserve:

- model and dynamic-model resolution;
- one-model-step durable commits;
- tool and background-task behavior;
- approval and authorization parking;
- compaction and session limits;
- retry classification;
- history and provider-message normalization;
- event ordering, hooks, tracing, and usage;
- task and subagent effects.

The built-in implementation may use private helpers unavailable to external
providers. It must still satisfy the same observable runner contract. Private
optimizations cannot add a second lifecycle path.

## Compatibility

`eve/agent-runners/v1` is a versioned provider SPI. It is narrower than the
ordinary public authoring API but is a supported contract for independently
published packages.

The compiler records the required runner API version in the compiled manifest.
The runtime rejects unsupported versions before creating a session. Extension
packages that distribute runner-backed agent nodes also advertise the runner
capability version in their extension compatibility manifest.

V1 changes must remain additive. A breaking contract change ships as
`eve/agent-runners/v2`; eve may support multiple versions through explicit
adapters. It must never guess compatibility from an npm package version.

Runner checkpoints also carry the provider `id`. A node cannot resume a
checkpoint produced by a different provider, even when both implement V1.

## Failure behavior

- A missing provider module or export fails before a runner starts.
- A runtime definition whose ID, API version, or capabilities differ from the
  compiled reference fails as a stale artifact.
- A malformed or non-JSON checkpoint fails at the runner boundary.
- A provider exception fails the active durable slice and follows eve's
  existing workflow retry policy.
- An abort propagates to the runner and then follows eve's existing turn and
  descendant cancellation lifecycle.
- An unsupported node capability fails compilation when statically knowable
  and session creation otherwise.
- A provider may not silently discard an incompatible checkpoint or restart a
  native conversation.

## Delivery

1. Define the internal runner-neutral result, event, checkpoint, tool-host, and
   sandbox-host contracts. Add an adapter that maps them to the existing
   `StepFn` lifecycle.
2. Adapt the built-in eve tool loop without exposing the new authoring API.
   Prove byte-equivalent compiled output where the manifest has not yet gained
   a runner field and unchanged event behavior in integration tests.
3. Split common durable session state from built-in-runner state. Remove the
   requirement for custom runners to fabricate a model, history, or compaction
   configuration.
4. Add the generic runner variant to `defineAgent`, normalization, compiled
   manifest schemas, graph resolution, inspection, and module loading. Keep the
   module-map generator source-neutral.
5. Publish `eve/agent-runners/v1` and add compile-time/runtime compatibility
   validation. Cover root and subagent nodes with a deterministic external test
   runner that has no AI SDK dependency.
6. Implement `@eve/harness-agent` independently against V1. Its tests own
   HarnessAgent conversion, native checkpoints, stream translation, sandbox
   adaptation, and adapter compatibility.
7. Add scenario and e2e coverage for one-shot subagents, persistent subagents,
   root conversations, cancellation, restart, structured output, tools, and
   parent sandbox sharing.

## Invariants

- `eve` contains no external-runner-specific branch, import, setting, or
  manifest field.
- Every local agent node selects exactly one runner.
- The compiled source reference, not a global registry or provider ID, loads an
  external runner.
- eve owns durable lifecycle, control-plane events, tools, sandbox ownership,
  callbacks, and task effects.
- A runner owns only native execution and its opaque checkpoint.
- Runner checkpoints are JSON, provider-namespaced, and validated at every
  durable boundary.
- Live runner and native-session objects never cross a workflow step boundary.
- External runners never receive `HarnessSession`, `StepFn`, `StepResult`, or
  runtime graph internals.
- The module-map compiler remains provider-neutral.
- Root agents and local subagents use the same runner selection mechanism.
- Remote agents continue to use the remote eve session protocol.
- The built-in eve runner preserves current behavior while satisfying the same
  V1 contract.
