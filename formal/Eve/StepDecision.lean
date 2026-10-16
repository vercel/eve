/-!
# What happens after a step

A model of `decideStep` in `packages/eve/src/execution/session/step-decision.ts`, which decides
what follows a step from the session's state alone.

`decideStep` branches only on whether each part of its `StepState` is set or empty, so `State`
keeps exactly that: one `Bool` per part. Every theorem below quantifies over all states and is
checked by evaluation (`decide`), so it holds for each of them, not for samples. `Main.lean`
prints the decision for every state, and `step-decision.test.ts` checks the TypeScript against
that table, which keeps the two in step.
-/

namespace Eve.StepDecision

/-- `StepState`, by which of its parts are set. -/
structure State where
  /-- The stream ended the session. -/
  ended : Bool
  /-- A turn is open. -/
  turnOpen : Bool
  /-- The turn holds input it hasn't taken, and no open request holds messages back. -/
  queued : Bool
  /-- The turn has answers the session hasn't weighed. -/
  unweighed : Bool
  /-- The session waits on requests it asked. -/
  requests : Bool
  /-- The session waits on its own sign-ins. -/
  signIns : Bool
  /-- The runtime runs calls for the turn's suspended steps. -/
  calls : Bool
  /-- Some of those calls' runs haven't started. Read only with `calls`. -/
  dispatch : Bool
  /-- The model has input it hasn't read: the history ends on it, or a task's result waits. -/
  unread : Bool
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
  else if !s.turnOpen then .park
  else if s.queued || s.unweighed then .run
  else if s.requests || s.signIns then .wait .person
  else if s.calls then .wait (.calls s.dispatch)
  else if s.unread then .run
  else if s.tasks then .wait .tasks
  else .parkOpen

/-- Every state, for proofs by evaluation: `∀ s, p s` reduces to a check of each `Bool`. -/
theorem forall_state {p : State → Prop} :
    (∀ a b c d e f g h i j, p ⟨a, b, c, d, e, f, g, h, i, j⟩) → ∀ s, p s := by
  intro h s
  cases s
  apply h

/-! ## What the decision guarantees -/

/-- What can end a pause: an answer or a sign-in callback, the calls' results, or a task. -/
def source (s : State) : Pause → Bool
  | .person => s.requests || s.signIns
  | .calls dispatch => s.calls && dispatch == s.dispatch
  | .tasks => s.tasks

/-- A turn never waits on nothing: every pause has something that can end it. -/
theorem waits_on_something :
    ∀ s, (match decideStep s with
      | .wait p => source s p
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

/-- When the turn runs: input it holds or answers to weigh run first; input the model hasn't
read runs once nothing the session asked for is outstanding. -/
theorem runs_iff :
    ∀ s, decideStep s = .run ↔
      (s.ended = false ∧ s.turnOpen = true ∧
        (s.queued || s.unweighed ||
          (!(s.requests || s.signIns || s.calls) && s.unread)) = true) := by
  apply forall_state
  decide

/-- No busy loop: the turn runs only with something to read. A step reads it, so a run that
leaves the same state behind is a step that read nothing. -/
theorem runs_only_with_input :
    ∀ s, decideStep s = .run → (s.queued || s.unweighed || s.unread) = true := by
  apply forall_state
  decide

/-- A turn that waits on its own person waits on them, unless input or answers come first. -/
theorem person_first :
    ∀ s, s.ended = false → s.turnOpen = true → s.queued = false → s.unweighed = false →
      (s.requests || s.signIns) = true → decideStep s = .wait .person := by
  apply forall_state
  decide

/-- The session parks open exactly when a step left a turn open with nothing to wake it. -/
theorem parks_open_iff :
    ∀ s, decideStep s = .parkOpen ↔
      (s.ended = false ∧ s.turnOpen = true ∧ s.queued = false ∧ s.unweighed = false ∧
        s.requests = false ∧ s.signIns = false ∧ s.calls = false ∧ s.unread = false ∧
        s.tasks = false) := by
  apply forall_state
  decide

/-- The state with a pause's source cleared, as its answer, result, or task does. -/
def clear (s : State) : Pause → State
  | .person => { s with requests := false, signIns := false }
  | .calls _ => { s with calls := false, dispatch := false }
  | .tasks => { s with tasks := false }

/-- No pause outlives its cause: once what a turn waits on clears, it waits on that no more. -/
theorem pause_ends_with_its_source :
    ∀ s, (match decideStep s with
      | .wait p => decideStep (clear s p) != .wait p
      | _ => true) = true := by
  apply forall_state
  decide

/-- What a turn waits on doesn't depend on what ranks below it: while it waits on its person,
calls, unread input, and tasks change nothing; while it waits on calls, unread input and tasks
change nothing. -/
theorem waits_ignore_lower :
    ∀ s, (match decideStep s with
      | .wait .person =>
        decideStep { s with calls := !s.calls, unread := !s.unread, tasks := !s.tasks } ==
          .wait .person
      | .wait (.calls d) =>
        decideStep { s with unread := !s.unread, tasks := !s.tasks } == .wait (.calls d)
      | _ => true) = true := by
  apply forall_state
  decide

/-! ## Nothing that changes the decision goes unnoticed

While a turn waits, `SessionExecution.resume` in `turn.ts` wakes only for what its pause names:
answers and sign-in callbacks for a person, every call's result or a task-wait timer for calls,
and a task settling for tasks. Everything else waits in the queue. `resumes` is that code, and
`arrive` is what each arrival can do to the state. Steering and cancellation interrupt every
pause by signal, so they aren't arrivals here. -/

inductive Arrival where
  /-- An answer: to all of the session's own requests, or some; it may need weighing. -/
  | answer (all weigh : Bool)
  /-- A sign-in callback: for all of the session's own sign-ins, or some. -/
  | callback (all : Bool)
  /-- A call's result, the last one or not. A task wait's timeout answers its call like one. -/
  | result (last : Bool)
  /-- A task settles, the last working one or not; its result waits for the model. -/
  | taskSettled (last : Bool)
  /-- Someone else's message, which waits for the turn to end. -/
  | message
  deriving DecidableEq, Repr

def arrive : Arrival → State → State
  -- The session weighs answers only to requests it asked; it forwards the rest.
  | .answer all weigh, s =>
    { s with requests := s.requests && !all, unweighed := s.unweighed || (weigh && s.requests) }
  | .callback all, s => { s with signIns := s.signIns && !all }
  | .result last, s =>
    if s.calls && last then { s with calls := false, dispatch := false, unread := true } else s
  | .taskSettled last, s => { s with tasks := s.tasks && !last, unread := true }
  | .message, s => s

/-- What wakes each pause in `resume`. -/
def resumes : Pause → Arrival → Bool
  | .person, .answer .. | .person, .callback _ => true
  | .calls _, .result last => last
  | .tasks, .taskSettled _ => true
  | _, _ => false

/-- No lost wake-up: whatever changes a waiting turn's decision wakes it. -/
theorem no_lost_wakeup :
    ∀ s a, (match decideStep s with
      | .wait p => decideStep (arrive a s) == decideStep s || resumes p a
      | _ => true) = true := by
  apply forall_state
  intro b₀ b₁ b₂ b₃ b₄ b₅ b₆ b₇ b₈ b₉ a
  cases a <;> decide +revert

/-- If a task's result woke a turn waiting on calls, the model would read it before the calls
finish; `resume` leaves it, and the decision agrees: the turn still waits on its calls. -/
example :
    let s : State := ⟨false, true, false, false, false, false, true, false, false, true⟩
    decideStep (arrive (.taskSettled false) s) = decideStep s := by
  decide

/-! ## The change preserves what the steps did before

Before this change, each step said what came next: `StepResult.next` (another step, `done`, or
nothing), `held` (tasks or a request), and `steered`. `previous` is the resolver that read them.
The two agree on every state a step could leave, and `Reported` says which those are: what each
step guaranteed about its report and the state it left. The `example`s after the theorem show
that the guarantees are needed. A shadow run of both resolvers over the integration suites
found them equal at all 1,464 step ends they reached. -/

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
  let person := s.requests || s.signIns
  -- A step said it runs again exactly when the state shows what the model reads next.
  (r.steered || r.next == .step) ==
    (s.turnOpen && (s.queued || s.unweighed || (!person && !s.calls && s.unread))) &&
  -- `held` came only with `next: null`, and `steered` only with another step.
  (r.held == .none || r.next == .none) && (!r.steered || r.next == .step) &&
  -- A step reports `done` exactly when it ended the session.
  (r.next == .done) == s.ended &&
  -- `park` held on a request only when the session waits on its own asks.
  (r.held != .request || (person && s.turnOpen)) &&
  -- The model held on tasks only when nothing else stopped the turn.
  (r.held != .tasks || (s.tasks && s.turnOpen && !person && !s.calls)) &&
  -- A plain stop isn't a person's: the step checked them first.
  (r.held != .none || r.next != .none || !person) &&
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
    let s : State := ⟨false, true, false, false, false, false, false, false, false, true⟩
    decideStep s = .wait .tasks ∧ previous r s = .park := by
  decide

/-- Without the guarantee that a step says it runs again when the model has input to read, the
two differ: the step held on tasks while tool results waited, and the session now runs. -/
example :
    let r : Report := ⟨false, .none, .tasks⟩
    let s : State := ⟨false, true, false, false, false, false, false, false, true, true⟩
    decideStep s = .run ∧ previous r s = .wait .tasks := by
  decide

/-! ## Agreement with what readers see

`decisionDisagreement` in `step-decision-check.ts` warns in `eve dev` when the decision disagrees
with `waiting(view, turnId)`, which is what clients read. `verdict` is that check. The tables say
whom the turn waits on and the decision says what resumes it, so a pause on calls or tasks agrees
with a person their run or task asked; and the tables don't see input the model hasn't read, so a
run beside working tasks agrees with their work. `TablesAgree` says what the tables show for each
state; given it, the check stays silent on every state but a stranded one. -/

/-- What `waiting(view, turnId)` says for the open turn. -/
inductive Tables where
  | person
  | work
  /-- `waiting` is `undefined`: the session can make progress by itself. -/
  | session
  | noTurn
  deriving DecidableEq, Repr

/-- `decisionDisagreement`: whether it stays silent. -/
def verdict (s : State) : Decision → Tables → Bool
  | .done, _ => true
  | .park, t => t == .noTurn
  | .parkOpen, _ => false
  | .run, t => t == .session || (s.tasks && t == .work)
  | .wait .person, t => t == .person
  | .wait .tasks, t => t == .work || t == .person
  | .wait (.calls true), t => t == .session || t == .work || t == .person
  | .wait (.calls false), t => t == .work || t == .person

/-- What the tables show for the session's state. -/
def TablesAgree (s : State) (t : Tables) : Bool :=
  let person := s.requests || s.signIns
  let runs := s.queued || s.unweighed || (!person && !s.calls && s.unread)
  (t == .noTurn) == !s.turnOpen &&
  -- Input the turn holds and answers to weigh are the session's work. Input the model hasn't read
  -- is too, though beside working tasks the tables see their work.
  (!runs || t == .session || (s.tasks && t == .work)) &&
  -- Its own asks are open interactions under the turn.
  (runs || !person || t == .person) &&
  -- Calls in flight, or calls a run hasn't started, or a person a run asked.
  (runs || person || !s.calls || t == .work || t == .person || (s.dispatch && t == .session)) &&
  -- Tasks working on the turn's calls, or a person a task asked.
  (runs || person || s.calls || !s.tasks || t == .work || t == .person)

theorem agrees_with_tables :
    ∀ s t, decideStep s ≠ .parkOpen → TablesAgree s t = true →
      verdict s (decideStep s) t = true := by
  apply forall_state
  intro a b c d e f g h i j t
  cases t <;> revert a b c d e f g h i j <;> decide

/-- A stranded turn is always flagged, whatever the tables say. -/
theorem flags_stranded : ∀ s t, decideStep s = .parkOpen → verdict s (decideStep s) t = false := by
  apply forall_state
  intro a b c d e f g h i j t
  cases t <;> revert a b c d e f g h i j <;> decide

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

/-- info: 'Eve.StepDecision.runs_only_with_input' does not depend on any axioms -/
#guard_msgs in
#print axioms runs_only_with_input

/-- info: 'Eve.StepDecision.person_first' does not depend on any axioms -/
#guard_msgs in
#print axioms person_first

/-- info: 'Eve.StepDecision.parks_open_iff' does not depend on any axioms -/
#guard_msgs in
#print axioms parks_open_iff

/-- info: 'Eve.StepDecision.pause_ends_with_its_source' depends on axioms: [propext] -/
#guard_msgs in
#print axioms pause_ends_with_its_source

/-- info: 'Eve.StepDecision.waits_ignore_lower' depends on axioms: [propext] -/
#guard_msgs in
#print axioms waits_ignore_lower

/-- info: 'Eve.StepDecision.no_lost_wakeup' depends on axioms: [propext] -/
#guard_msgs in
#print axioms no_lost_wakeup

/-- info: 'Eve.StepDecision.refines_previous' depends on axioms: [propext] -/
#guard_msgs in
#print axioms refines_previous

/-- info: 'Eve.StepDecision.agrees_with_tables' does not depend on any axioms -/
#guard_msgs in
#print axioms agrees_with_tables

/-- info: 'Eve.StepDecision.flags_stranded' does not depend on any axioms -/
#guard_msgs in
#print axioms flags_stranded

end Eve.StepDecision
