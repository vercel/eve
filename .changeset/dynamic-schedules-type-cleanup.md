---
"eve": patch
---

Clarify the experimental dynamic schedules types and error messages, and deprecate the top-level identity fields of `ScheduleOccurrenceEvent` in favor of `occurrence`.

The `scope` and `preparePayload` contexts are now exported as `ScheduleScopeResolverContext` and `SchedulePreparePayloadContext`. No fields were removed and runtime behavior is unchanged.
