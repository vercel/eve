---
"eve": minor
---

Approval response policies now run for Cancel as well as Approve (`response.decision` is `"approve" | "cancel"`), so a responder the policy rejects can no longer cancel someone else's request; a policy that only restricts approval should return `{ status: "allowed" }` for `cancel`. The responder moved from `responder` to `response.principal`, alongside `request.principal`.
