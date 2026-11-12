---
"eve": patch
---

Model calls now retry when a stream chunk fails the provider's schema (`AI_TypeValidationError`) or when AI Gateway's provider stream ends before the response finishes (`gateway_stream_terminated`).

Thanks @zackleman for reporting these in #5911 and #5912.
