---
"eve": patch
---

Model calls now retry when a stream chunk fails the provider's schema (`AI_TypeValidationError`), when AI Gateway's provider stream ends before the response finishes (`gateway_stream_terminated`), and when an AI Gateway BYOK attempt fails transiently but the Gateway reports its own system-credential retry's error instead.

A BYOK failure masked this way is now also named by the BYOK attempt's error in `model.retried` and failed turns, rather than by the Gateway retry's rejection (for example `invalid_encrypted_content`), which the request eve sent never hit.

Thanks @zackleman for reporting these in #5911, #5912, and #5913.
