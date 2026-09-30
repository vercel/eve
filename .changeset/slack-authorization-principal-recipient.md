---
"eve": patch
---

Slack now sends sign-in challenges and approval feedback privately to the Slack user behind the event's principal, not to whoever spoke last in the thread. Channel state replaces `approvalResponderUsers` and `pendingApprovalCandidateUsers` with a single `slackUsersByPrincipal` map.
