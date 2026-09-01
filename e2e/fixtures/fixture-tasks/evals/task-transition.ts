import { defineEval, type EveEvalDefinition, type EveEvalInput } from "eve/evals";

type Lifecycle = "absent" | "working" | "input_required" | "completed" | "failed" | "cancelled";
type TransitionOutcome = "accepted" | "noop" | "rejected" | "emitted" | "observed";

interface StatePattern {
  readonly lifecycle?: Lifecycle | readonly Lifecycle[];
  readonly outstandingInput?: "none" | "batch" | "partial-batch" | "authorization";
  readonly executor?: "unbound" | "active" | "parked" | "terminal";
  readonly dispatch?: "absent" | "prepared" | "acknowledged" | "rejected";
  readonly agent?: "available" | "busy";
  readonly parent?: "active" | "parked" | "finalizing";
  readonly ownership?: "owned" | "unowned";
  readonly usage?: "absent" | "retained";
}

type SemanticInput =
  | "delegate"
  | "dispatch-start"
  | "dispatch-batch"
  | "complete"
  | "fail"
  | "cancel"
  | "settle-executor"
  | "require-input"
  | "answer-input"
  | "authorization-callback"
  | "start-turn"
  | "agent-continuation"
  | "task-peek"
  | "task-notification"
  | "task-update"
  | "parent-message";

type SemanticEvent =
  | "background-receipt"
  | "input-requested"
  | "authorization-required"
  | "authorization-completed"
  | "task-ready-notification"
  | "task-update-notification";

type SemanticSideEffect =
  | "task-view-append"
  | "task-index-write"
  | "child-dispatch"
  | "child-delivery"
  | "child-abort"
  | "parent-model-step"
  | "parent-wake"
  | "task-view-read"
  | "authorization-request";

interface TransitionSpec {
  readonly preState: StatePattern;
  readonly input: SemanticInput;
  readonly guards: readonly string[];
  readonly expected: {
    readonly outcome: TransitionOutcome;
    readonly postState: StatePattern;
    readonly events: {
      readonly emitted?: readonly SemanticEvent[];
      readonly suppressed?: readonly SemanticEvent[];
    };
    readonly sideEffects: {
      readonly executed?: readonly SemanticSideEffect[];
      readonly suppressed?: readonly SemanticSideEffect[];
    };
  };
}

function transition(spec: TransitionSpec): TransitionSpec {
  return spec;
}

/**
 * Stable semantic identities for the task acceptance contract. Presentation
 * order and transport variants never participate in anchor identity.
 */
export const TASK_TRANSITIONS = {
  "task.lifecycle.complete.accepted-nonterminal": transition({
    preState: { lifecycle: ["working", "input_required"] },
    input: "complete",
    guards: ["task-is-nonterminal"],
    expected: {
      outcome: "accepted",
      postState: { lifecycle: "completed", outstandingInput: "none" },
      events: { emitted: ["task-ready-notification"] },
      sideEffects: { executed: ["task-view-append", "parent-wake"] },
    },
  }),
  "task.lifecycle.fail.accepted-nonterminal": transition({
    preState: { lifecycle: ["working", "input_required"] },
    input: "fail",
    guards: ["task-is-nonterminal"],
    expected: {
      outcome: "accepted",
      postState: { lifecycle: "failed", outstandingInput: "none" },
      events: { emitted: ["task-ready-notification"] },
      sideEffects: { executed: ["task-view-append", "parent-wake"] },
    },
  }),
  "task.lifecycle.cancel.accepted-nonterminal": transition({
    preState: { lifecycle: ["working", "input_required"] },
    input: "cancel",
    guards: ["task-is-nonterminal"],
    expected: {
      outcome: "accepted",
      postState: { lifecycle: "cancelled", outstandingInput: "none" },
      events: { emitted: ["task-ready-notification"] },
      sideEffects: { executed: ["task-view-append", "parent-wake", "child-abort"] },
    },
  }),
  "task.lifecycle.cancel.noop-already-cancelled": transition({
    preState: { lifecycle: "cancelled" },
    input: "cancel",
    guards: ["task-is-already-cancelled"],
    expected: {
      outcome: "noop",
      postState: { lifecycle: "cancelled" },
      events: { suppressed: ["task-ready-notification"] },
      sideEffects: { suppressed: ["task-view-append", "parent-wake", "child-abort"] },
    },
  }),
  "task.lifecycle.result.rejected-already-terminal": transition({
    preState: { lifecycle: ["completed", "failed", "cancelled"] },
    input: "complete",
    guards: ["task-is-terminal"],
    expected: {
      outcome: "rejected",
      postState: { lifecycle: ["completed", "failed", "cancelled"] },
      events: { suppressed: ["task-ready-notification"] },
      sideEffects: { suppressed: ["task-view-append", "parent-wake"] },
    },
  }),
  "task.executor.settle.accepted-terminal": transition({
    preState: { lifecycle: ["completed", "failed", "cancelled"], executor: "parked" },
    input: "settle-executor",
    guards: ["task-is-terminal", "executor-is-not-terminal"],
    expected: {
      outcome: "accepted",
      postState: { lifecycle: ["completed", "failed", "cancelled"], executor: "terminal" },
      events: {},
      sideEffects: { executed: ["task-view-append"] },
    },
  }),
  "task.executor.settle.rejected-nonterminal": transition({
    preState: { lifecycle: ["working", "input_required"] },
    input: "settle-executor",
    guards: ["task-is-nonterminal"],
    expected: {
      outcome: "rejected",
      postState: { lifecycle: ["working", "input_required"] },
      events: {},
      sideEffects: { suppressed: ["task-view-append"] },
    },
  }),
  "task.input.require.accepted-valid-batch": transition({
    preState: { lifecycle: ["working", "input_required"] },
    input: "require-input",
    guards: ["batch-is-nonempty", "request-ids-are-unique"],
    expected: {
      outcome: "accepted",
      postState: { lifecycle: "input_required", outstandingInput: "batch" },
      events: { emitted: ["input-requested", "task-ready-notification"] },
      sideEffects: { executed: ["task-view-append", "parent-wake"] },
    },
  }),
  "task.input.require.rejected-invalid-batch": transition({
    preState: { lifecycle: ["working", "input_required"] },
    input: "require-input",
    guards: ["batch-is-empty-or-request-ids-are-invalid"],
    expected: {
      outcome: "rejected",
      postState: { lifecycle: ["working", "input_required"] },
      events: { suppressed: ["input-requested", "task-ready-notification"] },
      sideEffects: { suppressed: ["task-view-append", "parent-wake"] },
    },
  }),
  "task.input.answer.accepted-partial": transition({
    preState: { lifecycle: "input_required", outstandingInput: "batch" },
    input: "answer-input",
    guards: ["some-request-ids-match", "some-requests-remain"],
    expected: {
      outcome: "accepted",
      postState: { lifecycle: "input_required", outstandingInput: "partial-batch" },
      events: {},
      sideEffects: { executed: ["child-delivery", "task-view-append"] },
    },
  }),
  "task.input.answer.accepted-complete": transition({
    preState: { lifecycle: "input_required", outstandingInput: "batch" },
    input: "answer-input",
    guards: ["all-outstanding-request-ids-match"],
    expected: {
      outcome: "accepted",
      postState: { lifecycle: "working", outstandingInput: "none" },
      events: {},
      sideEffects: {
        executed: ["child-delivery", "task-view-append"],
        suppressed: ["parent-model-step"],
      },
    },
  }),
  "task.input.answer.noop-stale": transition({
    preState: { lifecycle: "input_required", outstandingInput: "batch" },
    input: "answer-input",
    guards: ["no-request-id-matches"],
    expected: {
      outcome: "noop",
      postState: { lifecycle: "input_required", outstandingInput: "batch" },
      events: {},
      sideEffects: { suppressed: ["child-delivery", "task-view-append", "parent-model-step"] },
    },
  }),
  "task.input.route.observed-stale-unrouted": transition({
    preState: { lifecycle: "input_required", outstandingInput: "batch" },
    input: "answer-input",
    guards: ["request-route-is-no-longer-registered"],
    expected: {
      outcome: "observed",
      postState: { lifecycle: "input_required", outstandingInput: "batch" },
      events: {},
      sideEffects: {
        executed: ["parent-model-step"],
        suppressed: ["child-delivery", "task-view-append"],
      },
    },
  }),
  "task.executor.start-turn.accepted-unbound": transition({
    preState: { lifecycle: ["working", "input_required"], executor: "unbound" },
    input: "start-turn",
    guards: ["task-id-matches", "child-session-is-unbound"],
    expected: {
      outcome: "accepted",
      postState: { lifecycle: ["working", "input_required"], executor: "active" },
      events: {},
      sideEffects: { executed: ["task-view-append"] },
    },
  }),
  "task.executor.start-turn.noop-same-turn": transition({
    preState: { lifecycle: ["working", "input_required"], executor: "active" },
    input: "start-turn",
    guards: ["task-id-matches", "child-session-and-turn-match"],
    expected: {
      outcome: "noop",
      postState: { lifecycle: ["working", "input_required"], executor: "active" },
      events: {},
      sideEffects: { suppressed: ["task-view-append"] },
    },
  }),
  "task.executor.start-turn.rejected-session-mismatch": transition({
    preState: { lifecycle: ["working", "input_required"], executor: "active" },
    input: "start-turn",
    guards: ["task-id-matches", "child-session-differs"],
    expected: {
      outcome: "rejected",
      postState: { lifecycle: ["working", "input_required"], executor: "active" },
      events: {},
      sideEffects: { suppressed: ["task-view-append"] },
    },
  }),
  "task.dispatch.start.accepted-acknowledged": transition({
    preState: { lifecycle: "absent", dispatch: "absent", ownership: "unowned" },
    input: "dispatch-start",
    guards: ["child-acknowledges-private-address"],
    expected: {
      outcome: "accepted",
      postState: { lifecycle: "working", dispatch: "acknowledged", ownership: "owned" },
      events: { emitted: ["background-receipt"] },
      sideEffects: { executed: ["child-dispatch", "task-index-write"] },
    },
  }),
  "task.dispatch.start.rejected-unreachable": transition({
    preState: { lifecycle: "absent", dispatch: "absent", ownership: "unowned" },
    input: "dispatch-start",
    guards: ["child-start-is-unreachable"],
    expected: {
      outcome: "accepted",
      postState: { lifecycle: "failed", dispatch: "acknowledged", ownership: "owned" },
      events: { emitted: ["background-receipt", "task-failed-notification"] },
      sideEffects: { executed: ["child-dispatch", "task-index-write"] },
    },
  }),
  "task.dispatch-batch.start.accepted-partial-failure": transition({
    preState: { dispatch: "absent" },
    input: "dispatch-batch",
    guards: ["one-member-is-unreachable", "other-members-are-reachable"],
    expected: {
      outcome: "accepted",
      postState: { lifecycle: ["working", "failed"], dispatch: "acknowledged", ownership: "owned" },
      events: { emitted: ["background-receipt", "task-failed-notification"] },
      sideEffects: { executed: ["child-dispatch", "task-index-write"] },
    },
  }),
  "task.agent.continue.accepted-terminal-available": transition({
    preState: { lifecycle: ["completed", "failed", "cancelled"], agent: "available" },
    input: "agent-continuation",
    guards: ["source-task-is-terminal", "agent-has-no-nonterminal-task"],
    expected: {
      outcome: "accepted",
      postState: { lifecycle: "working", agent: "busy", ownership: "owned" },
      events: { emitted: ["background-receipt"] },
      sideEffects: { executed: ["task-index-write", "child-delivery"] },
    },
  }),
  "task.agent.continue.rejected-agent-busy": transition({
    preState: { agent: "busy" },
    input: "agent-continuation",
    guards: ["agent-has-a-nonterminal-task"],
    expected: {
      outcome: "rejected",
      postState: { agent: "busy" },
      events: { suppressed: ["background-receipt"] },
      sideEffects: { suppressed: ["task-index-write", "child-delivery"] },
    },
  }),
  "task.update.emitted-working": transition({
    preState: { lifecycle: "working" },
    input: "task-update",
    guards: ["child-is-owned-by-task"],
    expected: {
      outcome: "emitted",
      postState: { lifecycle: "working" },
      events: { emitted: ["task-update-notification"] },
      sideEffects: { executed: ["parent-wake"], suppressed: ["task-view-append"] },
    },
  }),
  "task.authorization.callback.accepted-current-attempt": transition({
    preState: { lifecycle: "input_required", outstandingInput: "authorization" },
    input: "authorization-callback",
    guards: ["callback-matches-current-attempt"],
    expected: {
      outcome: "accepted",
      postState: { lifecycle: "working", outstandingInput: "none" },
      events: { emitted: ["authorization-completed"] },
      sideEffects: { executed: ["authorization-request", "task-view-append"] },
    },
  }),
  "task.control.peek.observed-owned": transition({
    preState: { ownership: "owned" },
    input: "task-peek",
    guards: ["parent-owns-every-requested-task"],
    expected: {
      outcome: "observed",
      postState: { ownership: "owned" },
      events: {},
      sideEffects: { executed: ["task-view-read"], suppressed: ["task-view-append"] },
    },
  }),
  "task.parent.wake.emitted-ready": transition({
    preState: { lifecycle: ["input_required", "completed", "failed", "cancelled"] },
    input: "task-notification",
    guards: ["task-entered-a-ready-status"],
    expected: {
      outcome: "emitted",
      postState: { lifecycle: ["input_required", "completed", "failed", "cancelled"] },
      events: { emitted: ["task-ready-notification"] },
      sideEffects: { executed: ["parent-wake"] },
    },
  }),
  "task.parent-interaction.send.accepted-live-children": transition({
    preState: { agent: "busy", parent: "active" },
    input: "parent-message",
    guards: ["background-children-remain-nonterminal"],
    expected: {
      outcome: "accepted",
      postState: { agent: "busy", parent: "active" },
      events: {},
      sideEffects: { executed: ["parent-model-step"] },
    },
  }),
  "task.join.evaluate.observed-partial": transition({
    preState: { lifecycle: ["completed", "input_required"] },
    input: "task-peek",
    guards: ["at-least-one-task-is-nonterminal"],
    expected: {
      outcome: "observed",
      postState: { lifecycle: ["completed", "input_required"] },
      events: {},
      sideEffects: { executed: ["task-view-read", "parent-model-step"] },
    },
  }),
  "task.join.evaluate.observed-all-terminal": transition({
    preState: { lifecycle: "completed" },
    input: "task-peek",
    guards: ["all-joined-tasks-are-terminal"],
    expected: {
      outcome: "observed",
      postState: { lifecycle: "completed" },
      events: {},
      sideEffects: { executed: ["task-view-read", "parent-model-step"] },
    },
  }),
} as const satisfies Record<string, TransitionSpec>;

export type TaskTransitionAnchor = keyof typeof TASK_TRANSITIONS;

export interface TaskTransitionDeclaration {
  readonly primary: TaskTransitionAnchor;
  readonly setup?: readonly TaskTransitionAnchor[];
  readonly dimensions: {
    readonly transport: "local" | "remote" | "mixed" | "not-applicable";
    readonly parentPhase?: "active" | "parked" | "finalizing";
  };
}

type TaskEvalInput = Omit<EveEvalInput, "metadata"> & {
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly transition: TaskTransitionDeclaration;
};

/** Defines one task eval and expands its transition into executable-run metadata. */
export function defineTaskEval(input: TaskEvalInput): EveEvalDefinition {
  const { metadata, transition: declaration, ...evalInput } = input;
  const spec = TASK_TRANSITIONS[declaration.primary];
  return defineEval({
    ...evalInput,
    metadata: {
      ...metadata,
      transition: {
        anchor: declaration.primary,
        dimensions: declaration.dimensions,
        expected: spec.expected,
        guards: spec.guards,
        input: spec.input,
        preState: spec.preState,
        setup: declaration.setup ?? [],
      },
    },
  });
}
