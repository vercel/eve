---
"eve": minor
---

Agent calls and workflow tool calls now run as detached tasks: each call returns a `{ status: "working", taskId }` receipt at once, and the model either waits for the result with the new `task_wait` tool or keeps working and receives it later in the same turn, because no turn ends while tasks it started are working. Results arrive as `<task_result>` blocks in `task.result` messages instead of prose notification turns, and a `[Tasks]` note replaces the `[Agents]` and `[Task state]` notes.

Upgrading:

- Workflow tools no longer block by default. Set `attached: true` on `defineWorkflowTool` to keep a call holding its turn with its result as the tool result; `execution: "background"` is removed, and eve's `sleep` and `ask_question` are attached.
- A turn that tries to end while its tasks work is held. In an interactive root session the stream emits `turn.completed` with `held: true` and `session.waiting`, and the turn resumes under the same `turnId`; elsewhere the model's text before the hold streams as `message.completed` with `interim: true`, so a scheduled run posts once and a subagent replies once, after its tasks settle. A `final_output` call made while the turn's tasks work, or while results it has not read are waiting, returns an error naming those tasks instead of ending the turn.
- A steering message ends the turn's `task_wait` calls and attached calls, such as `sleep`, but never stops a detached task. Only the turn's own principal can steer it; another principal's message waits until the turn ends.
- `taskDeliveryPolicy` and the `TaskDeliveryPolicy` type are removed from channel, client, Chat SDK, and Slack sends, along with cohorts. `TaskReceipt` moved from `eve/tools` to `eve/client`, which also exports `TaskWaitOutput` and `TaskCancelOutput` for the results of `task_wait` and `task_cancel`, and the `experimental.tasks` agent option is removed.
- A session holds at most 20 working tasks; a call over the limit fails with `TOO_MANY_TASKS`.
