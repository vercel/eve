# HITL conformance matrix

<!-- Generated from conformance.ts by matrix.test.ts. Do not edit by hand. -->

Each channel and client against each rule in [`contract.ts`](./contract.ts), as
[`conformance.ts`](./conformance.ts) records it. The suite holds every cell to this
table: a ✅ cell must pass, and a ❌ cell passes only while the rule fails with its
recorded symptom. Regenerate it after changing either file:

```sh
pnpm --filter eve exec vitest run --config vitest.unit.config.ts channel-conformance/matrix -u
```

✅ passes · ❌ broken · — not supported (the platform lacks a capability the rule
needs, or the client declines it below)

| Rule | `chat-sdk` | `chat-sdk-text` | `discord` | `github` | `linear` | `linq` | `slack` | `teams` | `telegram` | `tui` | `twilio` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| a rendered question shows every option a person can choose | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing a rendered option answers the pending question with that option | ✅ | — | ✅ | — | — | — | ✅ | ✅ | ✅ | ✅ | — |
| a text reply matching an option answers the only pending question | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a text reply that matches no option answers the question with the person's words | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a text reply answers an open-ended question with the person's words | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing an option of an answered question sends it to the agent as new input | ✅ | — | ✅ | — | — | — | ✅ | ✅ | ✅ | — | — |
| pressing options of two pending questions answers each with its own option | ✅ | — | ✅ | — | — | — | ✅ | ✅ | ✅ | ✅ | — |
| a text reply matching an option does not answer either of two pending questions | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a tool approval shows a choice to approve and one to cancel | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing Approve runs the gated tool | ✅ | — | ✅ | — | — | — | ✅ | ✅ | ✅ | ✅ | — |
| pressing Approve twice runs the gated tool once | ✅ | — | ✅ | — | — | — | ✅ | ✅ | ✅ | ✅ | — |
| pressing Approve on one of two pending approvals runs only that tool | ✅ | — | ✅ | — | — | — | ✅ | ✅ | ✅ | ✅ | — |
| answering an approval and a question pending together settles both | ✅ | — | ✅ | — | — | — | ✅ | ✅ | ✅ | ✅ | — |
| pressing Cancel stops the gated tool without running it | ✅ | — | ✅ | — | — | — | ✅ | ✅ | ✅ | ✅ | — |
| a text reply of approve runs the gated tool | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| a text reply of cancel stops the gated tool without running it | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| pressing an option clears the question's buttons | ✅ | — | ✅ | — | — | — | ✅ | ✅ | ✅ | ✅ | — |
| answering a question by text clears its buttons | ✅ | — | — | — | — | — | ❌ | ✅ | ✅ | ✅ | — |
| pressing an option names who answered on the question | ❌ | — | ❌ | — | — | — | ✅ | ❌ | ❌ | — | — |
| answering a question by text names who answered on the question | ❌ | — | — | — | — | — | ❌ | ❌ | ❌ | — | — |
| pressing Approve clears the approval's buttons | ✅ | — | ✅ | — | — | — | ✅ | ✅ | ✅ | ✅ | — |
| approving by text clears the approval's buttons | ✅ | — | — | — | — | — | ✅ | ✅ | ✅ | — | — |
| pressing Approve names who approved on the approval | ❌ | — | ❌ | — | — | — | ✅ | ✅ | ❌ | — | — |
| approving by text names who approved on the approval | ❌ | — | — | — | — | — | ❌ | ❌ | ❌ | — | — |

## Broken

- **chat-sdk**, pressing an option names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **chat-sdk**, answering a question by text names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **chat-sdk**, pressing Approve names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **chat-sdk**, approving by text names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **discord**, pressing an option names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **discord**, pressing Approve names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **slack**, answering a question by text clears its buttons: only the button interaction handler edits a question; a typed answer leaves it
- **slack**, answering a question by text names who answered on the question: only the button interaction handler edits a question; a typed answer leaves it
- **slack**, approving by text names who approved on the approval: the card loses its buttons after a typed approval but doesn't say who approved
- **teams**, pressing an option names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **teams**, answering a question by text names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **teams**, approving by text names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **telegram**, pressing an option names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **telegram**, answering a question by text names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **telegram**, pressing Approve names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **telegram**, approving by text names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder

## Declined

- **tui**, pressing an option of an answered question sends it to the agent as new input: an answered question's drawer closes, so nothing is left to press
- **tui**, a text reply of approve runs the gated tool: the approval drawer holds the keyboard; a person answers it with y or n
- **tui**, a text reply of cancel stops the gated tool without running it: the approval drawer holds the keyboard; a person answers it with y or n
- **tui**, pressing an option names who answered on the question: one person answers at their own terminal; there's nobody else to tell
- **tui**, answering a question by text names who answered on the question: one person answers at their own terminal; there's nobody else to tell
- **tui**, approving by text clears the approval's buttons: the approval drawer holds the keyboard; a person answers it with y or n
- **tui**, pressing Approve names who approved on the approval: one person answers at their own terminal; there's nobody else to tell
- **tui**, approving by text names who approved on the approval: the approval drawer holds the keyboard; a person answers it with y or n
