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

| Rule | `chat-sdk` | `chat-sdk-text` | `chat-sdk-dm` | `discord` | `discord-dm` | `github` | `linear` | `linq` | `linq-dm` | `slack` | `slack-dm` | `teams` | `teams-dm` | `telegram` | `telegram-dm` | `tui` | `twilio` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| a rendered question shows every option a person can choose | ✅ | ✅ | — | ✅ | — | ✅ | ✅ | ✅ | — | ✅ | — | ✅ | — | ✅ | — | ✅ | ✅ |
| pressing a rendered option answers the pending question with that option | ✅ | — | ✅ | ✅ | ✅ | — | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| a text reply matching an option answers the only pending question | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a text reply that matches no option answers the question with the person's words | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a text reply answers an open-ended question with the person's words | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing an option of an answered question sends it to the agent as new input | ✅ | — | — | ✅ | — | — | — | — | — | ✅ | — | ✅ | — | ✅ | — | — | — |
| pressing options of two pending questions answers each with its own option | ✅ | — | — | ✅ | — | — | — | — | — | ✅ | — | ✅ | — | ✅ | — | ✅ | — |
| a text reply matching an option does not answer either of two pending questions | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a tool approval shows a choice to approve and one to cancel | ✅ | ✅ | — | ✅ | — | ✅ | ✅ | ✅ | — | ✅ | — | ✅ | — | ✅ | — | ✅ | ✅ |
| pressing Approve runs the gated tool | ✅ | — | ✅ | ✅ | ✅ | — | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| pressing Approve twice runs the gated tool once | ✅ | — | — | ✅ | — | — | — | — | — | ✅ | — | ✅ | — | ✅ | — | ✅ | — |
| pressing Approve on one of two pending approvals runs only that tool | ✅ | — | — | ✅ | — | — | — | — | — | ✅ | — | ✅ | — | ✅ | — | ✅ | — |
| answering an approval and a question pending together settles both | ✅ | — | — | ✅ | — | — | — | — | — | ✅ | — | ✅ | — | ✅ | — | ✅ | — |
| pressing Cancel stops the gated tool without running it | ✅ | — | — | ✅ | — | — | — | — | — | ✅ | — | ✅ | — | ✅ | — | ✅ | — |
| a text reply of approve runs the gated tool | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| a text reply of cancel stops the gated tool without running it | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| pressing an option clears the question's buttons | ✅ | — | — | ✅ | — | — | — | — | — | ✅ | — | ✅ | — | ✅ | — | ✅ | — |
| answering a question by text clears its buttons | ✅ | — | ✅ | — | — | — | — | — | — | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| pressing an option names who answered on the question | ❌ | — | — | ❌ | — | — | — | — | — | ✅ | — | ❌ | — | ❌ | — | — | — |
| answering a question by text names who answered on the question | ❌ | — | ❌ | — | — | — | — | — | — | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | — |
| pressing Approve clears the approval's buttons | ✅ | — | — | ✅ | — | — | — | — | — | ✅ | — | ✅ | — | ✅ | — | ✅ | — |
| approving by text clears the approval's buttons | ✅ | — | ✅ | — | — | — | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |
| pressing Approve names who approved on the approval | ❌ | — | — | ❌ | — | — | — | — | — | ✅ | — | ✅ | — | ❌ | — | — | — |
| approving by text names who approved on the approval | ❌ | — | ❌ | — | — | — | — | — | — | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | — |
| an exhausted session budget asks to Approve or Stop | ✅ | ✅ | — | ❌ | — | ✅ | ✅ | ✅ | — | ✅ | — | ✅ | — | ✅ | — | ✅ | ✅ |
| pressing Approve on a budget prompt finishes the held turn | ✅ | — | — | ❌ | — | — | — | — | — | ✅ | — | ✅ | — | ✅ | — | ✅ | — |
| a text reply of approve on a budget prompt finishes the held turn | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing Stop on a budget prompt ends the held turn and asks again next time | ✅ | — | ✅ | — | — | — | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | — |
| a text reply of stop on a budget prompt ends the held turn and asks again next time | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| a reply that answers neither budget option keeps the prompt open | ❌ | ❌ | ❌ | — | — | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| a sign-in names the service and shows its sign-in link | ❌ | ✅ | ✅ | ❌ | ❌ | — | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| a sign-in shows its confirmation code | ❌ | ✅ | ✅ | ❌ | ❌ | — | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ |
| a sign-in keeps its link and code out of messages everyone can see | ✅ | — | — | ✅ | — | ✅ | ❌ | ✅ | — | ✅ | — | ❌ | — | ✅ | — | — | — |
| a sign-in without a link shows its instructions | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ |
| completing a sign-in runs the tool that asked for it | ✅ | ✅ | — | ✅ | — | ✅ | ✅ | ✅ | — | ✅ | — | ✅ | — | ✅ | — | ✅ | ✅ |
| completing a sign-in tells the person it succeeded | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| a new message during a sign-in cancels it and gets an answer | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a cancelled sign-in tells the person it was cancelled | ✅ | ✅ | ✅ | — | — | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

## Broken

- **chat-sdk**, pressing an option names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **chat-sdk**, answering a question by text names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **chat-sdk**, pressing Approve names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **chat-sdk**, approving by text names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **chat-sdk**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **chat-sdk**, a sign-in names the service and shows its sign-in link: outside a DM the bot says to continue in a direct message but never sends one
- **chat-sdk**, a sign-in shows its confirmation code: outside a DM the bot says to continue in a direct message but never sends one
- **chat-sdk**, a sign-in without a link shows its instructions: outside a DM the bot says to continue in a direct message but never sends one
- **chat-sdk-text**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **chat-sdk-dm**, answering a question by text names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **chat-sdk-dm**, approving by text names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **chat-sdk-dm**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **discord**, pressing an option names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **discord**, pressing Approve names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **discord**, an exhausted session budget asks to Approve or Stop: a budget prompt's request id overflows Discord's 100-character custom_id, so posting it throws
- **discord**, pressing Approve on a budget prompt finishes the held turn: a budget prompt's request id overflows Discord's 100-character custom_id, so posting it throws
- **discord**, a sign-in names the service and shows its sign-in link: the channel has no default sign-in renderer
- **discord**, a sign-in shows its confirmation code: the channel has no default sign-in renderer
- **discord**, a sign-in without a link shows its instructions: the channel has no default sign-in renderer
- **discord**, completing a sign-in tells the person it succeeded: the channel has no default sign-in renderer
- **discord-dm**, a sign-in names the service and shows its sign-in link: the channel has no default sign-in renderer
- **discord-dm**, a sign-in shows its confirmation code: the channel has no default sign-in renderer
- **discord-dm**, a sign-in without a link shows its instructions: the channel has no default sign-in renderer
- **discord-dm**, completing a sign-in tells the person it succeeded: the channel has no default sign-in renderer
- **github**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **github**, a sign-in without a link shows its instructions: the channel has no default sign-in renderer
- **github**, completing a sign-in tells the person it succeeded: the channel has no default sign-in renderer
- **github**, a cancelled sign-in tells the person it was cancelled: the channel has no default sign-in renderer
- **linear**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **linear**, a sign-in keeps its link and code out of messages everyone can see: the code is in the elicitation body the whole issue sees; who sees the auth signal's link is unverified
- **linq**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **linq**, a sign-in names the service and shows its sign-in link: outside a DM the bot says to continue in a direct message but never sends one
- **linq**, a sign-in shows its confirmation code: outside a DM the bot says to continue in a direct message but never sends one
- **linq**, a sign-in without a link shows its instructions: outside a DM the bot says to continue in a direct message but never sends one
- **linq-dm**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **slack**, answering a question by text clears its buttons: only the button interaction handler edits a question; a typed answer leaves it
- **slack**, answering a question by text names who answered on the question: only the button interaction handler edits a question; a typed answer leaves it
- **slack**, approving by text names who approved on the approval: the card loses its buttons after a typed approval but doesn't say who approved
- **slack**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **slack**, a sign-in without a link shows its instructions: Slack sends the private sign-in prompt only for a challenge with a URL
- **slack-dm**, answering a question by text clears its buttons: only the button interaction handler edits a question; a typed answer leaves it
- **slack-dm**, answering a question by text names who answered on the question: only the button interaction handler edits a question; a typed answer leaves it
- **slack-dm**, approving by text names who approved on the approval: the card loses its buttons after a typed approval but doesn't say who approved
- **slack-dm**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **slack-dm**, a sign-in without a link shows its instructions: Slack sends the private sign-in prompt only for a challenge with a URL
- **teams**, pressing an option names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **teams**, answering a question by text names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **teams**, approving by text names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **teams**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **teams**, a sign-in shows its confirmation code: the Teams sign-in card omits the challenge's user code
- **teams**, a sign-in keeps its link and code out of messages everyone can see: the sign-in prompt, link included, is posted to the whole thread
- **teams**, a sign-in without a link shows its instructions: the Teams sign-in card omits the challenge's instructions
- **teams-dm**, answering a question by text names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **teams-dm**, approving by text names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **teams-dm**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **teams-dm**, a sign-in shows its confirmation code: the Teams sign-in card omits the challenge's user code
- **teams-dm**, a sign-in without a link shows its instructions: the Teams sign-in card omits the challenge's instructions
- **telegram**, pressing an option names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **telegram**, answering a question by text names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **telegram**, pressing Approve names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **telegram**, approving by text names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **telegram**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **telegram-dm**, answering a question by text names who answered on the question: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **telegram-dm**, approving by text names who approved on the approval: a resolved prompt doesn't say who answered; input.resolved carries no responder
- **telegram-dm**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **tui**, pressing Stop on a budget prompt ends the held turn and asks again next time: a re-raised budget prompt keeps its request id, and eve/client ignores ids it has seen
- **tui**, a text reply of stop on a budget prompt ends the held turn and asks again next time: a re-raised budget prompt keeps its request id, and eve/client ignores ids it has seen
- **tui**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **tui**, a sign-in names the service and shows its sign-in link: the TUI labels a sign-in with the tool name, not the challenge's displayName
- **twilio**, a reply that answers neither budget option keeps the prompt open: eve coalesces the queued reply with the later approve, which then matches no option
- **twilio**, a sign-in names the service and shows its sign-in link: the channel has no default sign-in renderer
- **twilio**, a sign-in shows its confirmation code: the channel has no default sign-in renderer
- **twilio**, a sign-in without a link shows its instructions: the channel has no default sign-in renderer
- **twilio**, completing a sign-in tells the person it succeeded: the channel has no default sign-in renderer
- **twilio**, a cancelled sign-in tells the person it was cancelled: the channel has no default sign-in renderer

## Declined

- **chat-sdk-dm**, a rendered question shows every option a person can choose: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, pressing an option of an answered question sends it to the agent as new input: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, pressing options of two pending questions answers each with its own option: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, a tool approval shows a choice to approve and one to cancel: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, pressing Approve twice runs the gated tool once: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, pressing Approve on one of two pending approvals runs only that tool: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, answering an approval and a question pending together settles both: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, pressing Cancel stops the gated tool without running it: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, pressing an option clears the question's buttons: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, pressing an option names who answered on the question: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, pressing Approve clears the approval's buttons: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, pressing Approve names who approved on the approval: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, an exhausted session budget asks to Approve or Stop: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, pressing Approve on a budget prompt finishes the held turn: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, a sign-in keeps its link and code out of messages everyone can see: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **chat-sdk-dm**, completing a sign-in runs the tool that asked for it: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, a rendered question shows every option a person can choose: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, pressing an option of an answered question sends it to the agent as new input: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, pressing options of two pending questions answers each with its own option: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, a tool approval shows a choice to approve and one to cancel: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, pressing Approve twice runs the gated tool once: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, pressing Approve on one of two pending approvals runs only that tool: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, answering an approval and a question pending together settles both: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, pressing Cancel stops the gated tool without running it: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, pressing an option clears the question's buttons: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, pressing an option names who answered on the question: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, pressing Approve clears the approval's buttons: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, pressing Approve names who approved on the approval: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, an exhausted session budget asks to Approve or Stop: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, pressing Approve on a budget prompt finishes the held turn: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, a sign-in keeps its link and code out of messages everyone can see: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **discord-dm**, completing a sign-in runs the tool that asked for it: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, a rendered question shows every option a person can choose: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, pressing an option of an answered question sends it to the agent as new input: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, pressing options of two pending questions answers each with its own option: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, a tool approval shows a choice to approve and one to cancel: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, pressing Approve twice runs the gated tool once: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, pressing Approve on one of two pending approvals runs only that tool: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, answering an approval and a question pending together settles both: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, pressing Cancel stops the gated tool without running it: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, pressing an option clears the question's buttons: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, pressing an option names who answered on the question: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, pressing Approve clears the approval's buttons: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, pressing Approve names who approved on the approval: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, an exhausted session budget asks to Approve or Stop: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, pressing Approve on a budget prompt finishes the held turn: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, a sign-in keeps its link and code out of messages everyone can see: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **linq-dm**, completing a sign-in runs the tool that asked for it: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, a rendered question shows every option a person can choose: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, pressing an option of an answered question sends it to the agent as new input: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, pressing options of two pending questions answers each with its own option: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, a tool approval shows a choice to approve and one to cancel: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, pressing Approve twice runs the gated tool once: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, pressing Approve on one of two pending approvals runs only that tool: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, answering an approval and a question pending together settles both: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, pressing Cancel stops the gated tool without running it: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, pressing an option clears the question's buttons: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, pressing an option names who answered on the question: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, pressing Approve clears the approval's buttons: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, pressing Approve names who approved on the approval: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, an exhausted session budget asks to Approve or Stop: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, pressing Approve on a budget prompt finishes the held turn: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, a sign-in keeps its link and code out of messages everyone can see: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **slack-dm**, completing a sign-in runs the tool that asked for it: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, a rendered question shows every option a person can choose: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, pressing an option of an answered question sends it to the agent as new input: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, pressing options of two pending questions answers each with its own option: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, a tool approval shows a choice to approve and one to cancel: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, pressing Approve twice runs the gated tool once: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, pressing Approve on one of two pending approvals runs only that tool: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, answering an approval and a question pending together settles both: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, pressing Cancel stops the gated tool without running it: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, pressing an option clears the question's buttons: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, pressing an option names who answered on the question: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, pressing Approve clears the approval's buttons: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, pressing Approve names who approved on the approval: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, an exhausted session budget asks to Approve or Stop: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, pressing Approve on a budget prompt finishes the held turn: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, a sign-in keeps its link and code out of messages everyone can see: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **teams-dm**, completing a sign-in runs the tool that asked for it: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, a rendered question shows every option a person can choose: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, pressing an option of an answered question sends it to the agent as new input: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, pressing options of two pending questions answers each with its own option: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, a tool approval shows a choice to approve and one to cancel: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, pressing Approve twice runs the gated tool once: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, pressing Approve on one of two pending approvals runs only that tool: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, answering an approval and a question pending together settles both: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, pressing Cancel stops the gated tool without running it: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, pressing an option clears the question's buttons: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, pressing an option names who answered on the question: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, pressing Approve clears the approval's buttons: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, pressing Approve names who approved on the approval: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, an exhausted session budget asks to Approve or Stop: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, pressing Approve on a budget prompt finishes the held turn: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, a sign-in keeps its link and code out of messages everyone can see: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **telegram-dm**, completing a sign-in runs the tool that asked for it: it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
- **tui**, pressing an option of an answered question sends it to the agent as new input: an answered question's drawer closes, so nothing is left to press
- **tui**, a text reply of approve runs the gated tool: the approval drawer holds the keyboard; a person answers it with y or n
- **tui**, a text reply of cancel stops the gated tool without running it: the approval drawer holds the keyboard; a person answers it with y or n
- **tui**, pressing an option names who answered on the question: one person answers at their own terminal; there's nobody else to tell
- **tui**, answering a question by text names who answered on the question: one person answers at their own terminal; there's nobody else to tell
- **tui**, approving by text clears the approval's buttons: the approval drawer holds the keyboard; a person answers it with y or n
- **tui**, pressing Approve names who approved on the approval: one person answers at their own terminal; there's nobody else to tell
- **tui**, approving by text names who approved on the approval: the approval drawer holds the keyboard; a person answers it with y or n
