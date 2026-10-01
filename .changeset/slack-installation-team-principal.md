---
"eve": patch
---

Slack now identifies a person by the app installation workspace on both messages and button clicks, as `slack:<installation team>:<user>`. Before, a Slack Connect or Enterprise Grid user could get one principal from their messages and another from approval clicks, so they were asked to sign in to the same connection again. Their principal changes once with this release, so they sign in to user-scoped connections one more time.
