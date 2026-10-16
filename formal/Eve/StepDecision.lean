/-!
# What happens after a turn step

A model of `decideStep` in `packages/eve/src/execution/session/step-decision.ts`. A turn step
reports one thing, that the model runs again; the session decides everything else from the state
the step left.

`decideStep` branches only on whether each part of its `StepState` is set or empty, so `State`
keeps exactly that: one `Bool` per part. Every theorem below quantifies over all states and is
checked by evaluation (`decide`), so it holds for each of them, not for samples.
`Main.lean` prints the decision for every state, and `step-decision.test.ts` checks the
TypeScript against that table, which keeps the two in step.
-/

namespace Eve.StepDecision

/-- `StepState`, by which of its parts are set. -/
structure State where
  /-- The stream ended the session. -/
  ended : Bool
  /-- A turn is open. -/
  turnOpen : Bool
  /-- The step reported that the model runs again (`StepResult.again`). -/
  again : Bool
  /-- The session waits on requests it asked. -/
  requests : Bool
  /-- The session waits on its own sign-ins. -/
  signIns : Bool
  /-- The runtime runs calls for the turn's suspended steps. -/
  calls : Bool
  /-- Those calls start workflow tool runs first. Read only with `calls`. -/
  dispatch : Bool
  /-- Tasks have calls still to answer. -/
  tasks : Bool
  deriving DecidableEq, Repr

inductive Pause where
  | person
  | calls (dispatch : Bool)
  | tasks
  deriving DecidableEq, Repr

inductive Decision where
  | done
  | run
  | wait (pause : Pause)
  | park
  /-- The session parks with a turn open and nothing to wake it. -/
  | parkOpen
  deriving DecidableEq, Repr

/-- `decideStep`, one branch per branch. -/
def decideStep (s : State) : Decision :=
  if s.ended then .done
  else if s.again then .run
  else if !s.turnOpen then .park
  else if s.requests || s.signIns then .wait .person
  else if s.calls then .wait (.calls s.dispatch)
  else if s.tasks then .wait .tasks
  else .parkOpen

/-- Every state, for proofs by evaluation: `∀ s, p s` reduces to a check of each `Bool`. -/
theorem forall_state {p : State → Prop} :
    (∀ a b c d e f g h, p ⟨a, b, c, d, e, f, g, h⟩) → ∀ s, p s := by
  intro h s
  cases s
  apply h

/-! ## What the decision guarantees -/

/-- What can end a pause: an answer or a sign-in callback, the calls' results, or a task. -/
def wakes (s : State) : Pause → Bool
  | .person => s.requests || s.signIns
  | .calls dispatch => s.calls && dispatch == s.dispatch
  | .tasks => s.tasks

/-- A turn never waits on nothing: every pause has something that can end it. -/
theorem waits_on_something :
    ∀ s, (match decideStep s with
      | .wait p => wakes s p
      | _ => true) = true := by
  apply forall_state
  decide

/-- Only a turn waits: the session never waits with no turn open. -/
theorem waits_only_in_a_turn :
    ∀ s, (match decideStep s with
      | .wait _ => s.turnOpen
      | _ => true) = true := by
  apply forall_state
  decide

/-- The session's end always wins, and nothing else ends it. -/
theorem ends_iff : ∀ s, decideStep s = .done ↔ s.ended = true := by
  apply forall_state
  decide

/-- What the step reports runs: a model with input to read runs again, unless the session ended. -/
theorem runs_iff : ∀ s, decideStep s = .run ↔ (s.ended = false ∧ s.again = true) := by
  apply forall_state
  decide

/-- A turn that waits on its person waits on them, whatever else it waits on. -/
theorem person_first :
    ∀ s, s.ended = false → s.again = false → s.turnOpen = true →
      (s.requests || s.signIns) = true → decideStep s = .wait .person := by
  apply forall_state
  decide

/-- The session parks open exactly when a step left a turn open with nothing to wake it. -/
theorem parks_open_iff :
    ∀ s, decideStep s = .parkOpen ↔
      (s.ended = false ∧ s.again = false ∧ s.turnOpen = true ∧ s.requests = false ∧
        s.signIns = false ∧ s.calls = false ∧ s.tasks = false) := by
  apply forall_state
  decide

/-! ## The change preserves what the steps did before

Before this change, each step said what came next: `StepResult.next` (another step, `done`, or
nothing), `held` (tasks or a request), and `steered`. `previous` is the resolver that read them.
The two agree on every state a step can leave, and `Reported` says which those are: what each
step guaranteed about its report and the state it left. The `example`s after the theorem show
that each guarantee is needed. -/

inductive Next where
  | step
  | done
  | none
  deriving DecidableEq, Repr

inductive Held where
  | none
  | tasks
  | request
  deriving DecidableEq, Repr

structure Report where
  steered : Bool
  next : Next
  held : Held
  deriving DecidableEq, Repr

/-- `resolveSessionStepResult` and `pausedOrParked` before this change. -/
def previous (r : Report) (s : State) : Decision :=
  if r.steered then .run
  else if r.next = .done then .done
  else if r.held = .tasks then .wait .tasks
  else if r.held = .request then .wait .person
  else if r.next = .step then .run
  else if s.calls then .wait (.calls s.dispatch)
  else .park

/-- The resolver before couldn't tell an open turn's park from any other. -/
def Decision.parks : Decision → Decision
  | .parkOpen => .park
  | d => d

/-- The pair a step could return, with what each producer guaranteed. -/
def Reported (r : Report) (s : State) : Bool :=
  -- `again` is how the steps report what `next` and `steered` said.
  s.again == (r.steered || r.next == .step) &&
  -- `held` came only with `next: null`, and `steered` only with another step.
  (r.held == .none || r.next == .none) && (!r.steered || r.next == .step) &&
  -- A step reports `done` exactly when it ended the session.
  (r.next == .done) == s.ended &&
  -- `park` held on a request only when the session waits on its own asks.
  (r.held != .request || ((s.requests || s.signIns) && s.turnOpen)) &&
  -- The model held on tasks only when nothing else stopped the turn.
  (r.held != .tasks || (s.tasks && s.turnOpen && !s.requests && !s.signIns && !s.calls)) &&
  -- A plain stop isn't a person's: `park` checked them first.
  (r.held != .none || r.next != .none || !(s.requests || s.signIns)) &&
  -- A plain stop that leaves its turn open waits on calls.
  (r.held != .none || r.next != .none || !s.turnOpen || s.calls) &&
  -- Calls the runtime runs belong to an open turn.
  (!s.calls || s.turnOpen)

theorem refines_previous :
    ∀ (r : Report) (s : State), Reported r s = true →
      (decideStep s).parks = (previous r s).parks := by
  intro ⟨steered, next, held⟩
  apply forall_state
  cases next <;> cases held <;> revert steered <;> decide

/-- Without the guarantee that a plain stop leaving its turn open waits on calls, the two
differ: such a turn whose tasks work parked before, and now waits on the tasks. -/
example :
    let r : Report := ⟨false, .none, .none⟩
    let s : State := ⟨false, true, false, false, false, false, false, true⟩
    decideStep s = .wait .tasks ∧ previous r s = .park := by
  decide

/-- Without the guarantee that the steps hold on tasks only when nothing else stopped the turn,
the two differ: the model held on tasks while calls ran, and the session now waits on the calls. -/
example :
    let r : Report := ⟨false, .none, .tasks⟩
    let s : State := ⟨false, true, false, false, false, true, false, true⟩
    decideStep s = .wait (.calls false) ∧ previous r s = .wait .tasks := by
  decide

/-! ## Agreement with what readers see

`stepDisagreement` in `step-decision-check.ts` warns in `eve dev` when a step's decision
disagrees with `waiting(view, turnId)`, which is what clients read. `verdict` is that check.
`TablesAgree` says what the tables must show for each state; given it, the check never warns.
The `example`s after the theorem are states where the tables can legitimately show something
else, which the dev check would flag. -/

/-- What `waiting(view, turnId)` says for the open turn. -/
inductive Tables where
  | person
  | work
  /-- `waiting` is `undefined`: the session can make progress by itself. -/
  | session
  | noTurn
  deriving DecidableEq, Repr

inductive Verdict where
  | agrees
  /-- The turn waits on calls only requested, which the next durable step starts. -/
  | dispatchDeferred
  | disagrees
  deriving DecidableEq, Repr

/-- `stepDisagreement`. -/
def verdict : Decision → Tables → Verdict
  | .done, _ => .agrees
  | .wait .person, .person => .agrees
  | .wait .person, _ => .disagrees
  | .wait (.calls true), .session => .dispatchDeferred
  | .wait _, .work => .agrees
  | .wait _, _ => .disagrees
  | .run, .session => .agrees
  | .run, _ => .disagrees
  | .park, .noTurn | .park, .person => .agrees
  | .parkOpen, .noTurn | .parkOpen, .person => .agrees
  | .park, _ | .parkOpen, _ => .disagrees

/-- What the tables must say for the session's state, for `stepDisagreement` to stay silent. -/
def TablesAgree (s : State) (t : Tables) : Bool :=
  (t == .noTurn) == !s.turnOpen &&
  -- Unread input is the session's work.
  (!s.again || t == .session) &&
  -- Its own asks are open interactions under the turn.
  (s.again || !(s.requests || s.signIns) || t == .person) &&
  -- Calls in flight, or calls only requested.
  (s.again || s.requests || s.signIns || !s.calls ||
    if s.dispatch then t == .session || t == .work else t == .work) &&
  -- Tasks working on the turn's calls.
  (s.again || s.requests || s.signIns || s.calls || !s.tasks || t == .work)

theorem agrees_with_tables :
    ∀ s t, decideStep s ≠ .parkOpen → TablesAgree s t = true →
      verdict (decideStep s) t ≠ .disagrees := by
  apply forall_state
  intro a b c d e f g h t
  cases t <;> revert a b c d e f g h <;> decide

/-- A blocking call's run asked someone a question it relayed: `waiting` says the turn waits on
that person, and the session waits on the call, which resumes the turn. -/
example : verdict (decideStep ⟨false, true, false, false, false, true, false, false⟩) .person =
    .disagrees := by decide

/-- A task's relayed question: the turn waits on its person, and the session on the task. -/
example : verdict (decideStep ⟨false, true, false, false, false, false, false, true⟩) .person =
    .disagrees := by decide

/-- A parked `eve__task_wait` call: the session waits on it, and `waiting` reads a running call no
task serves as work the session does itself. -/
example : verdict (decideStep ⟨false, true, false, false, false, true, false, false⟩) .session =
    .disagrees := by decide

/-- Tool results the model hasn't read while a task works: the session runs the model, and
`waiting` says the turn waits on the task's call, since nothing in the tables marks the results
unread. -/
example : verdict (decideStep ⟨false, true, true, false, false, false, false, true⟩) .work =
    .disagrees := by decide

/-! ## Nothing assumed

The kernel checks every proof above. These fail the build if one ever rests on `sorry` or on
`native_decide`, which trusts compiled code instead of the kernel. -/

/-- info: 'Eve.StepDecision.waits_on_something' depends on axioms: [propext] -/
#guard_msgs in
#print axioms waits_on_something

/-- info: 'Eve.StepDecision.waits_only_in_a_turn' depends on axioms: [propext] -/
#guard_msgs in
#print axioms waits_only_in_a_turn

/-- info: 'Eve.StepDecision.ends_iff' does not depend on any axioms -/
#guard_msgs in
#print axioms ends_iff

/-- info: 'Eve.StepDecision.runs_iff' does not depend on any axioms -/
#guard_msgs in
#print axioms runs_iff

/-- info: 'Eve.StepDecision.person_first' does not depend on any axioms -/
#guard_msgs in
#print axioms person_first

/-- info: 'Eve.StepDecision.parks_open_iff' does not depend on any axioms -/
#guard_msgs in
#print axioms parks_open_iff

/-- info: 'Eve.StepDecision.refines_previous' depends on axioms: [propext] -/
#guard_msgs in
#print axioms refines_previous

/-- info: 'Eve.StepDecision.agrees_with_tables' depends on axioms: [propext] -/
#guard_msgs in
#print axioms agrees_with_tables

end Eve.StepDecision
