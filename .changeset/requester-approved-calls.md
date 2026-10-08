---
"eve": minor
---

Approved calls now always run as the requester. This closes a privilege escalation: when another person approved a call, it ran with the approver's identity and credentials, so a requester could get a tool to act with access they don't have. The call now keeps the identity and credentials of the person whose turn requested it, and approved workflow and agent calls are rechecked before dispatch. This reverses the execution-identity rule from #4368. Tools that should only proceed for certain approvers can still check `response.principal` in their `approval.response` policy.
