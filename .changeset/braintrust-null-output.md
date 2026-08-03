---
"eve": patch
---

The Braintrust eval reporter no longer aborts the entire run when an eval produces no agent turn. A null output is logged as an empty string instead of triggering Braintrust's "output must be specified" error.
