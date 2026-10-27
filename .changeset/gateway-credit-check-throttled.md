---
"eve": patch
---

Model calls that AI Gateway rejects with a 402 because it temporarily throttled the credit balance check now retry with backoff. They previously reported "AI Gateway credit balance exhausted", told users to add credits, and parked the session without retrying.
