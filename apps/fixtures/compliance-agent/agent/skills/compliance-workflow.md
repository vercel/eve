---
description: Follow this workflow for every financial transaction to satisfy compliance obligations.
---

Before initiating any transfer:

1. Call `fetch_customer` with the account number to confirm KYC tier and identity verification status.
2. Call `record_audit` with `event_type: "pii_accessed"` and the account number as the subject.
3. Call `initiate_transfer` with the validated inputs.
4. Call `record_audit` with `event_type: "transfer_initiated"` or `"approval_denied"` depending on the outcome.

If the transfer is denied or escalated, include the reason in the audit metadata.
