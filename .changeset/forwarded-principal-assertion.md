---
"eve": patch
---

`eveChannel({ trustedForwarders })` now receives what the forwarder asserts as a second argument. `assertion.principal` holds the stamped `current` and `initiator` contexts the forwarder asserts, so a receiver can limit a trusted forwarder to the identities it may speak for instead of accepting any principal it asserts.
