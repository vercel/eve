# HITL conformance matrix

<!-- Generated from conformance.ts by matrix.test.ts. Do not edit by hand. -->

Each channel and client against each rule in [`contract.ts`](./contract.ts), as
[`conformance.ts`](./conformance.ts) records it. The suite holds every cell to this
table: a ✅ cell must pass, and a ❌ cell passes only while the rule fails with its
recorded symptom. Regenerate it after changing either file:

```sh
pnpm --filter eve exec vitest run --config vitest.unit.config.ts channel-conformance/matrix -u
```

✅ passes · ❌ broken · — not supported

| Rule | `tui` | `chat-sdk` | `chat-sdk-dm` | `chat-sdk-text` | `discord` | `discord-dm` | `linq` | `linq-dm` | `slack` | `slack-dm` | `teams` | `teams-dm` | `telegram` | `telegram-dm` | `github` | `linear` | `twilio` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| a rendered question shows every option a person can choose | ✅ | ✅ |  | ✅ | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ | ✅ | ✅ |
| pressing a rendered option answers the pending question with that option | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| a text reply matching an option answers the only pending question | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a text reply that matches no option answers the question with the person's words | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a text reply answers an open-ended question with the person's words | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing an option of an answered question sends it to the agent as new input | —<sup>[3](#note-3)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| pressing options of two pending questions answers each with its own option | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| a text reply matching an option does not answer either of two pending questions | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a tool approval shows a choice to approve and one to cancel | ✅ | ✅ |  | ✅ | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ | ✅ | ✅ |
| pressing Approve runs the gated tool | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| pressing Approve twice runs the gated tool once | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| pressing Approve on one of two pending approvals runs only that tool | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| answering an approval and a question pending together settles both | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| pressing Cancel stops the gated tool without running it | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| a text reply of approve runs the gated tool | —<sup>[4](#note-4)</sup> | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a text reply of cancel stops the gated tool without running it | —<sup>[4](#note-4)</sup> | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing an option clears the question's buttons | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| answering a question by text clears its buttons | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ❌<sup>[5](#note-5)</sup> | ❌<sup>[5](#note-5)</sup> | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| pressing an option names who answered on the question | —<sup>[6](#note-6)</sup> | ❌<sup>[7](#note-7)</sup> |  | —<sup>[1](#note-1)</sup> | ❌<sup>[7](#note-7)</sup> |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ❌<sup>[7](#note-7)</sup> |  | ❌<sup>[7](#note-7)</sup> |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| answering a question by text names who answered on the question | —<sup>[6](#note-6)</sup> | ❌<sup>[7](#note-7)</sup> | ❌<sup>[7](#note-7)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ❌<sup>[5](#note-5)</sup> | ❌<sup>[5](#note-5)</sup> | ❌<sup>[7](#note-7)</sup> | ❌<sup>[7](#note-7)</sup> | ❌<sup>[7](#note-7)</sup> | ❌<sup>[7](#note-7)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| pressing Approve clears the approval's buttons | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| approving by text clears the approval's buttons | —<sup>[4](#note-4)</sup> | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| pressing Approve names who approved on the approval | —<sup>[6](#note-6)</sup> | ❌<sup>[7](#note-7)</sup> |  | —<sup>[1](#note-1)</sup> | ❌<sup>[7](#note-7)</sup> |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ❌<sup>[7](#note-7)</sup> |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| approving by text names who approved on the approval | —<sup>[4](#note-4)</sup> | ❌<sup>[7](#note-7)</sup> | ❌<sup>[7](#note-7)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ❌<sup>[8](#note-8)</sup> | ❌<sup>[8](#note-8)</sup> | ❌<sup>[7](#note-7)</sup> | ❌<sup>[7](#note-7)</sup> | ❌<sup>[7](#note-7)</sup> | ❌<sup>[7](#note-7)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| running out of budget asks the person whether to keep going | ✅ | ✅ |  | ✅ | ❌<sup>[9](#note-9)</sup> |  | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ | ✅ | ✅ |
| pressing Approve on a budget prompt lets the agent pick up where it left off | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ❌<sup>[9](#note-9)</sup> |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| a text reply of approve on a budget prompt lets the agent pick up where it left off | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing Stop on a budget prompt halts the work, and the next message asks again | ❌<sup>[10](#note-10)</sup> | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| a text reply of stop on a budget prompt halts the work, and the next message asks again | ❌<sup>[10](#note-10)</sup> | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a message sent during a budget prompt is answered once the person approves | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> |
| a sign-in names the service and shows its sign-in link | ❌<sup>[12](#note-12)</sup> | ❌<sup>[13](#note-13)</sup> | ✅ | ✅ | ❌<sup>[14](#note-14)</sup> | ❌<sup>[14](#note-14)</sup> | ❌<sup>[13](#note-13)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[15](#note-15)</sup> | ✅ | ❌<sup>[14](#note-14)</sup> |
| a sign-in shows its confirmation code | ✅ | ❌<sup>[13](#note-13)</sup> | ✅ | ✅ | ❌<sup>[14](#note-14)</sup> | ❌<sup>[14](#note-14)</sup> | ❌<sup>[13](#note-13)</sup> | ✅ | ✅ | ✅ | ❌<sup>[16](#note-16)</sup> | ❌<sup>[16](#note-16)</sup> | ✅ | ✅ | —<sup>[15](#note-15)</sup> | ✅ | ❌<sup>[14](#note-14)</sup> |
| only the person signing in sees the sign-in link and code | —<sup>[17](#note-17)</sup> | ✅ |  | —<sup>[17](#note-17)</sup> | ✅ |  | ✅ |  | ✅ |  | ❌<sup>[18](#note-18)</sup> |  | ✅ |  | ✅ | ❌<sup>[19](#note-19)</sup> | —<sup>[17](#note-17)</sup> |
| a sign-in without a link shows its instructions | ✅ | ❌<sup>[13](#note-13)</sup> | ✅ | ✅ | ❌<sup>[14](#note-14)</sup> | ❌<sup>[14](#note-14)</sup> | ❌<sup>[13](#note-13)</sup> | ✅ | ❌<sup>[20](#note-20)</sup> | ❌<sup>[20](#note-20)</sup> | ❌<sup>[21](#note-21)</sup> | ❌<sup>[21](#note-21)</sup> | ✅ | ✅ | ❌<sup>[14](#note-14)</sup> | ✅ | ❌<sup>[14](#note-14)</sup> |
| after signing in, the agent carries on with the request | ✅ | ✅ |  | ✅ | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ | ✅ | ✅ |
| completing a sign-in tells the person it succeeded | ✅ | ✅ | ✅ | ✅ | ❌<sup>[14](#note-14)</sup> | ❌<sup>[14](#note-14)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌<sup>[14](#note-14)</sup> | ✅ | ❌<sup>[14](#note-14)</sup> |
| moving on from a sign-in gets an answer, and signing in late doesn't run the dropped request | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| moving on from a sign-in tells the person it was cancelled | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌<sup>[14](#note-14)</sup> | ✅ | ❌<sup>[14](#note-14)</sup> |

## Notes

1. <a id="note-1"></a>the platform has no buttons a person can press
2. <a id="note-2"></a>the platform has no plain-text replies
3. <a id="note-3"></a>an answered question's drawer closes, so nothing is left to press
4. <a id="note-4"></a>the approval drawer holds the keyboard; a person answers it with y or n
5. <a id="note-5"></a>only the button interaction handler edits a question; a typed answer leaves it
6. <a id="note-6"></a>one person answers at their own terminal; there's nobody else to tell
7. <a id="note-7"></a>a resolved prompt doesn't say who answered; input.resolved carries no responder
8. <a id="note-8"></a>the card loses its buttons after a typed approval but doesn't say who approved
9. <a id="note-9"></a>a budget prompt's request id overflows Discord's 100-character custom_id, so posting it throws
10. <a id="note-10"></a>a re-raised budget prompt keeps its request id, and eve/client ignores ids it has seen
11. <a id="note-11"></a>eve coalesces the queued reply with the later approve, which then matches no option
12. <a id="note-12"></a>the TUI labels a sign-in with the tool name, not the challenge's displayName
13. <a id="note-13"></a>outside a DM the bot says to continue in a direct message but never sends one
14. <a id="note-14"></a>the channel has no default sign-in renderer
15. <a id="note-15"></a>the rule applies only where the conversation is shared or private, and this one is public
16. <a id="note-16"></a>the Teams sign-in card omits the challenge's user code
17. <a id="note-17"></a>the rule applies only where the conversation is public or shared, and this one is private
18. <a id="note-18"></a>the sign-in prompt, link included, is posted to the whole thread
19. <a id="note-19"></a>the code is in the elicitation body the whole issue sees; who sees the auth signal's link is unverified
20. <a id="note-20"></a>Slack sends the private sign-in prompt only for a challenge with a URL
21. <a id="note-21"></a>the Teams sign-in card omits the challenge's instructions
