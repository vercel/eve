# HITL conformance matrix

<!-- Generated from conformance.ts by matrix.test.ts. Do not edit by hand. -->

Each channel and client against each rule in [`contract.ts`](./contract.ts), as
[`conformance.ts`](./conformance.ts) records it. The suite holds every cell to this
table: a ✅ cell must pass, and a ❌ cell passes only while the rule fails with its
recorded symptom. Regenerate it after changing either file:

```sh
pnpm --filter eve exec vitest run --config vitest.unit.config.ts channel-conformance/matrix -u
```

✅ passes · ❌ broken · — not supported. Every ❌ and — cell links to a note on why;
cells with the same cause share one. A `-dm` column is the same channel in a
direct message instead of a shared thread.

| Rule | `chat-sdk` | `chat-sdk-text` | `chat-sdk-dm` | `discord` | `discord-dm` | `github` | `linear` | `linq` | `linq-dm` | `slack` | `slack-dm` | `teams` | `teams-dm` | `telegram` | `telegram-dm` | `tui` | `twilio` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| a rendered question shows every option a person can choose | ✅ | ✅ | —[^1] | ✅ | —[^1] | ✅ | ✅ | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | ✅ |
| pressing a rendered option answers the pending question with that option | ✅ | —[^2] | ✅ | ✅ | ✅ | —[^2] | —[^2] | —[^2] | —[^2] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —[^2] |
| a text reply matching an option answers the only pending question | ✅ | ✅ | ✅ | —[^3] | —[^3] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a text reply that matches no option answers the question with the person's words | ✅ | ✅ | ✅ | —[^3] | —[^3] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a text reply answers an open-ended question with the person's words | ✅ | ✅ | ✅ | —[^3] | —[^3] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing an option of an answered question sends it to the agent as new input | ✅ | —[^2] | —[^1] | ✅ | —[^1] | —[^2] | —[^2] | —[^2] | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | —[^4] | —[^2] |
| pressing options of two pending questions answers each with its own option | ✅ | —[^2] | —[^1] | ✅ | —[^1] | —[^2] | —[^2] | —[^2] | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^2] |
| a text reply matching an option does not answer either of two pending questions | ✅ | ✅ | ✅ | —[^3] | —[^3] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a tool approval shows a choice to approve and one to cancel | ✅ | ✅ | —[^1] | ✅ | —[^1] | ✅ | ✅ | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | ✅ |
| pressing Approve runs the gated tool | ✅ | —[^2] | ✅ | ✅ | ✅ | —[^2] | —[^2] | —[^2] | —[^2] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —[^2] |
| pressing Approve twice runs the gated tool once | ✅ | —[^2] | —[^1] | ✅ | —[^1] | —[^2] | —[^2] | —[^2] | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^2] |
| pressing Approve on one of two pending approvals runs only that tool | ✅ | —[^2] | —[^1] | ✅ | —[^1] | —[^2] | —[^2] | —[^2] | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^2] |
| answering an approval and a question pending together settles both | ✅ | —[^2] | —[^1] | ✅ | —[^1] | —[^2] | —[^2] | —[^2] | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^2] |
| pressing Cancel stops the gated tool without running it | ✅ | —[^2] | —[^1] | ✅ | —[^1] | —[^2] | —[^2] | —[^2] | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^2] |
| a text reply of approve runs the gated tool | ✅ | ✅ | ✅ | —[^3] | —[^3] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —[^5] | ✅ |
| a text reply of cancel stops the gated tool without running it | ✅ | ✅ | ✅ | —[^3] | —[^3] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —[^5] | ✅ |
| pressing an option clears the question's buttons | ✅ | —[^2] | —[^1] | ✅ | —[^1] | —[^2] | —[^2] | —[^2] | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^2] |
| answering a question by text clears its buttons | ✅ | —[^2] | ✅ | —[^3] | —[^3] | —[^2] | —[^2] | —[^2] | —[^2] | ❌[^6] | ❌[^6] | ✅ | ✅ | ✅ | ✅ | ✅ | —[^2] |
| pressing an option names who answered on the question | ❌[^7] | —[^2] | —[^1] | ❌[^7] | —[^1] | —[^2] | —[^2] | —[^2] | —[^1] | ✅ | —[^1] | ❌[^7] | —[^1] | ❌[^7] | —[^1] | —[^8] | —[^2] |
| answering a question by text names who answered on the question | ❌[^7] | —[^2] | ❌[^7] | —[^3] | —[^3] | —[^2] | —[^2] | —[^2] | —[^2] | ❌[^6] | ❌[^6] | ❌[^7] | ❌[^7] | ❌[^7] | ❌[^7] | —[^8] | —[^2] |
| pressing Approve clears the approval's buttons | ✅ | —[^2] | —[^1] | ✅ | —[^1] | —[^2] | —[^2] | —[^2] | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^2] |
| approving by text clears the approval's buttons | ✅ | —[^2] | ✅ | —[^3] | —[^3] | —[^2] | —[^2] | —[^2] | —[^2] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —[^5] | —[^2] |
| pressing Approve names who approved on the approval | ❌[^7] | —[^2] | —[^1] | ❌[^7] | —[^1] | —[^2] | —[^2] | —[^2] | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ❌[^7] | —[^1] | —[^8] | —[^2] |
| approving by text names who approved on the approval | ❌[^7] | —[^2] | ❌[^7] | —[^3] | —[^3] | —[^2] | —[^2] | —[^2] | —[^2] | ❌[^9] | ❌[^9] | ❌[^7] | ❌[^7] | ❌[^7] | ❌[^7] | —[^5] | —[^2] |
| an exhausted session budget asks to Approve or Stop | ✅ | ✅ | —[^1] | ❌[^10] | —[^1] | ✅ | ✅ | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | ✅ |
| pressing Approve on a budget prompt finishes the held turn | ✅ | —[^2] | —[^1] | ❌[^10] | —[^1] | —[^2] | —[^2] | —[^2] | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^2] |
| a text reply of approve on a budget prompt finishes the held turn | ✅ | ✅ | ✅ | —[^3] | —[^3] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing Stop on a budget prompt ends the held turn and asks again next time | ✅ | —[^2] | ✅ | —[^3] | —[^3] | —[^2] | —[^2] | —[^2] | —[^2] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌[^11] | —[^2] |
| a text reply of stop on a budget prompt ends the held turn and asks again next time | ✅ | ✅ | ✅ | —[^3] | —[^3] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌[^11] | ✅ |
| a reply that answers neither budget option keeps the prompt open | ❌[^12] | ❌[^12] | ❌[^12] | —[^3] | —[^3] | ❌[^12] | ❌[^12] | ❌[^12] | ❌[^12] | ❌[^12] | ❌[^12] | ❌[^12] | ❌[^12] | ❌[^12] | ❌[^12] | ❌[^12] | ❌[^12] |
| a sign-in names the service and shows its sign-in link | ❌[^13] | ✅ | ✅ | ❌[^14] | ❌[^14] | —[^15] | ✅ | ❌[^13] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌[^16] | ❌[^14] |
| a sign-in shows its confirmation code | ❌[^13] | ✅ | ✅ | ❌[^14] | ❌[^14] | —[^15] | ✅ | ❌[^13] | ✅ | ✅ | ✅ | ❌[^17] | ❌[^17] | ✅ | ✅ | ✅ | ❌[^14] |
| a sign-in keeps its link and code out of messages everyone can see | ✅ | —[^18] | —[^1] | ✅ | —[^1] | ✅ | ❌[^19] | ✅ | —[^1] | ✅ | —[^1] | ❌[^20] | —[^1] | ✅ | —[^1] | —[^18] | —[^18] |
| a sign-in without a link shows its instructions | ❌[^13] | ✅ | ✅ | ❌[^14] | ❌[^14] | ❌[^14] | ✅ | ❌[^13] | ✅ | ❌[^21] | ❌[^21] | ❌[^22] | ❌[^22] | ✅ | ✅ | ✅ | ❌[^14] |
| completing a sign-in runs the tool that asked for it | ✅ | ✅ | —[^1] | ✅ | —[^1] | ✅ | ✅ | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | —[^1] | ✅ | ✅ |
| completing a sign-in tells the person it succeeded | ✅ | ✅ | ✅ | ❌[^14] | ❌[^14] | ❌[^14] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌[^14] |
| a new message during a sign-in cancels it and gets an answer | ✅ | ✅ | ✅ | —[^3] | —[^3] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a cancelled sign-in tells the person it was cancelled | ✅ | ✅ | ✅ | —[^3] | —[^3] | ❌[^14] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌[^14] |

[^1]: — it doesn't vary between a shared thread and a DM, and the shared-thread column covers it
[^2]: — the platform has no buttons a person can press
[^3]: — the platform has no plain-text replies
[^4]: — an answered question's drawer closes, so nothing is left to press
[^5]: — the approval drawer holds the keyboard; a person answers it with y or n
[^6]: ❌ only the button interaction handler edits a question; a typed answer leaves it
[^7]: ❌ a resolved prompt doesn't say who answered; input.resolved carries no responder
[^8]: — one person answers at their own terminal; there's nobody else to tell
[^9]: ❌ the card loses its buttons after a typed approval but doesn't say who approved
[^10]: ❌ a budget prompt's request id overflows Discord's 100-character custom_id, so posting it throws
[^11]: ❌ a re-raised budget prompt keeps its request id, and eve/client ignores ids it has seen
[^12]: ❌ eve coalesces the queued reply with the later approve, which then matches no option
[^13]: ❌ outside a DM the bot says to continue in a direct message but never sends one
[^14]: ❌ the channel has no default sign-in renderer
[^15]: — the rule applies only where the conversation is shared or private, and this one is public
[^16]: ❌ the TUI labels a sign-in with the tool name, not the challenge's displayName
[^17]: ❌ the Teams sign-in card omits the challenge's user code
[^18]: — the rule applies only where the conversation is public or shared, and this one is private
[^19]: ❌ the code is in the elicitation body the whole issue sees; who sees the auth signal's link is unverified
[^20]: ❌ the sign-in prompt, link included, is posted to the whole thread
[^21]: ❌ Slack sends the private sign-in prompt only for a challenge with a URL
[^22]: ❌ the Teams sign-in card omits the challenge's instructions
