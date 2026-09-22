---
"eve": minor
---

Add `taskDeliveryPolicy: "auto" | "cohort"` to message sends. New channel sessions default to `"auto"`, allowing independently useful reports or silence until related work settles; schedules default to `"cohort"`, and explicit sends can select or update the session's policy.
