---
"eve": minor
---

Approval response policies now run for Cancel as well as Approve (`response.decision` is `"approve" | "cancel"`), so a responder the policy rejects can no longer cancel someone else's request. A policy that only restricts approval should return `{ status: "allowed" }` for `cancel`.
