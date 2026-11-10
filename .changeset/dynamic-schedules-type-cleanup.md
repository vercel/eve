---
"eve": patch
---

Clarify the experimental dynamic schedules types and error messages, and deprecate the top-level identity fields of `ScheduleOccurrenceEvent` in favor of `occurrence`.

The `preparePayload` context is now exported as `SchedulePreparePayloadContext`. No fields were removed and runtime behavior is unchanged.
