---
"eve": patch
---

Stop reporting a completed sign-in as failed when the call it resumes fails before its tool runs.

When a call that waited on a sign-in can no longer run (its stored input no longer matches the tool's schema, the tool changed or went away, or the policy now refuses it), the sign-in now settles as accepted instead of failed. Channels no longer show messages such as ":x: Plain authorization failed (The approved input is no longer valid…)" for a sign-in the person finished. The call's own error result still tells the model why it didn't run.
