---
issue: https://github.com/vercel/eve/issues/1084
status: implemented
last_updated: "2026-09-19"
---

# Background task delivery policy

Message sends choose when background results are reported; task execution and
session completion remain independent of that choice.

## Authoring

```ts
await from(address).send(message, { auth, taskDeliveryPolicy: "auto" });
await to(slack, target).send(message, { auth, taskDeliveryPolicy: "cohort" });
await session.send(message, { auth, taskDeliveryPolicy: "auto" });
```

`taskDeliveryPolicy: "auto" | "cohort"` is authored only on sends, including client
sends. New channel sessions default to `"auto"`; new schedule and internal child
sessions default to `"cohort"`. Explicit sends update the session policy, including
pending tasks; omission preserves the current value. Schedule handlers override
the default on their `send(...)`; Markdown schedules use the default.

## Observable behavior

A cohort contains overlapping tasks, including launches in later user turns.
`"cohort"` holds terminal outcomes until that cohort settles, then reports
the results together. `"auto"` allows each ready completion to invoke the parent;
results already queued from the same cohort may share a turn.

For independent tasks A and B, auto can report A while B runs. When A needs B to
produce a useful answer, the parent may stay silent after A and report both after
B settles. This is a model judgment about delivery, not a way to avoid the model
call. The runtime retains available outputs in the workflow tool run registry and includes the
whole cohort in subsequent reporting contexts. Received does not mean reported.
User input and intervention notifications remain serviceable under either policy.

## Runtime boundaries

Sends carry the policy through session creation or the durable inbox envelope.
Cross-channel sends supply a default to the receiver's local send. The last explicit
value wins when authored deliveries are coalesced. The workflow queue and reporting
prompt share one resolved value in `eve.runtime.taskDeliveryPolicy`.

Reporting projects cohort state from the existing workflow tool run registry. Auto exposes
available outputs while the cohort is pending and permits an empty delivery.
Cohort reports wait for settlement and require a response. Child calls and
structured outputs retain their explicit output contracts.

Scheduled task-mode sessions check pending workflow tasks as well as newly launched
tasks before finishing. A partial report cannot end the session and cancel siblings.
No separate store of reported or withheld task outputs is introduced.
