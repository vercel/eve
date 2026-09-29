---
issue: "https://github.com/vercel/eve/issues/3822"
status: in-progress
last_updated: "2026-09-29"
---

# Question response policies

> **AI status:** Written entirely by AI; human review pending.

## Authoring API

`ctx.ask(question, { response: authorizeAnswer })` accepts a named `"use step"` function. The policy receives `request`, `response`, `session`, and responder-bound `auth`, and returns `{ status: "allowed" }` or `{ status: "rejected", reason }`, as tool approval response policies do. The captured request includes the requester principal, call identity, and question; the submitted response includes the authenticated principal and option/text. Omitting the policy preserves unrestricted answers. There is no requester shorthand.

## Settlement

```text
Authenticated delivery → owner records candidate → asking run executes policy step
  → rejection: owner publishes candidate feedback; question stays pending
  → authorization: responder-specific challenge; question stays pending
  → allowance: owner accepts first live candidate, resolves question, acknowledges run
```

The callback stays in the asking workflow, reconstructed by replay, rather than in serialized proxy state. Auth uses the existing workflow step authorization loop, scoped to the candidate and bound to its responder. Candidates are bounded per pending question. Policies may run concurrently; only the owner session settles a question, in order with withdrawal and cancellation. Errors and invalid policy results reject the candidate without disclosing internal errors.

Parents relay candidate responses but must not retire a policy-protected question on forwarding. The originating session publishes the eventual resolution back through local and remote parents, which then retire their routes. Rejection never produces `input.resolved`; candidate feedback is distinct from terminal resolution.
