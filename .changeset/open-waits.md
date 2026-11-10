---
"eve": minor
---

Keep an approval or sign-in open when a message joins the turn waiting on it: the call waits as a task and runs once the person acts, instead of being withdrawn.

A message from anyone the channel admits joins a turn that waits on an approval or sign-in it asked for, even with `turnPolicy: "queue"`. In the step that reads the message, each call that still waits returns a receipt and becomes a task, and the model reads the results of the step's other calls, the message, and a `[Tasks]` note that lists the task as `awaiting-approval` or `awaiting-sign-in`. When the person approves or completes the sign-in, the call runs and its result reaches the model in a `task.result` message; a denial arrives the same way. The model can drop a waiting call with `eve__task_cancel`, which withdraws its approval or sign-in. From the first waiting call on, the session offers `eve__task_wait` and `eve__task_cancel`. The turn doesn't end while such a call waits; cancelling it, clearing the session, or a failed turn stops the call, and its task never reports. With no new message nothing changes.

A waiting call runs as the model made it: its `ctx.session.auth.sender` is whoever had spoken last when the model made the call. A call the caller approves, or whose sign-in the caller completes, runs with the caller's identity. A later call that needs a sign-in a waiting call holds waits on the same card instead of replacing it.

On the stream, the request stays `open`, its card keeps working, and the turn reports `turn.paused` awaiting it, even while other tasks still work. These calls publish no `task.started` or `task.ended`; their `call.settled` arrives when they run, are denied, or are dropped. Clients that cleared an approval or sign-in card when the next message arrived should keep it until `interaction.settled`.

Thanks @pcomans for proposing that a sign-in stay open when its caller steers past it, in the review of #6199.
