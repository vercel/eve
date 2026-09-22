---
issue: "TBD (maintainer-requested implementation; no matching issue found)"
status: implemented
last_updated: "2026-09-17"
---

# Automatic tool approval

## Authoring API

Add `auto({ model?, instructions?, criteria? })` to `eve/tools/approval`. `model` accepts any AI SDK `Experimental_EvaluationModel`, including a string resolved through the configured default provider, and defaults to `typesafe-ai/jev`. `instructions` and `criteria.clear` / `criteria.caution` override the classifier text.

```ts
import { defineTool } from "eve/tools";
import { auto } from "eve/tools/approval";

export default defineTool({
  // ...
  approval: auto(),
});
```

The helper asks one constrained choice question with `clear` and `caution` outcomes. `clear` returns `"approved"`; `caution` returns `"user-approval"`. Provider errors, invalid answers, timeouts, oversized input, and non-serializable tool input fail closed to user approval. Cancelling the active turn cancels evaluation instead of producing a prompt.

## Evidence and cancellation

The evaluation state contains the exact tool name and input. Assistant prose and conversation history are excluded. `ApprovalContext` adds `abortSignal` so the helper and custom asynchronous approval policies stop with the active turn.

## Policy

The default classifier returns caution for dangerous or unclear effects, including destructive data loss, credential exposure, financial transactions, deployments, public changes, external communication, privilege or system changes, and concealed execution.

`auto()` is not authorization. Applications must still enforce identity, tenancy, service permissions, allowlists, and other deterministic requirements. Tool input is sent to the selected evaluation provider, so authors must not use it for inputs the provider is not permitted to receive.
