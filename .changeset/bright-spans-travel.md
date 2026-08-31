---
"eve": minor
---

Preserve public trace content across principal-forwarding remote agents by accepting `eve.audience=public` W3C Baggage from callers authorized by `trustedForwarders`. This expands `forwardPrincipal` and `trustedForwarders`: with the default trace policy, accepted public remote sessions now record model and tool content unless a receiver policy narrows or drops capture.
