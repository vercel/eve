# Channel conformance matrix

<!-- Generated from conformance.ts by matrix.test.ts. Do not edit by hand. -->

Each channel and client against each rule in [`contract.ts`](./contract.ts), as
[`conformance.ts`](./conformance.ts) records it. The suite holds every cell to this
table: a ✅ cell must pass, and a ❌ cell passes only while the rule fails with its
recorded symptom. Regenerate it after changing either file:

```sh
pnpm --filter eve exec vitest run --config vitest.unit.config.ts channel-conformance/matrix -u
```

✅ passes · ❌ broken · — not supported

## Questions

| Rule | `tui` | `web chat` | `chat-sdk` | `chat-sdk-dm` | `chat-sdk-text` | `discord` | `discord-dm` | `linq` | `linq-dm` | `slack` | `slack-dm` | `teams` | `teams-dm` | `telegram` | `telegram-dm` | `github` | `linear` | `photon` | `twilio` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| a rendered question shows every option a person can choose | ✅ | ✅ | ✅ |  | ✅ | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |
| pressing a rendered option answers the pending question with that option | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| a text reply matching an option answers the only pending question | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a text reply that matches no option answers the question with the person's words | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a text reply answers an open-ended question with the person's words | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing options of two pending questions answers each with its own option | ✅ | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| text replies answer two pending questions one at a time, in the order shown | —<sup>[3](#note-3)</sup> | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing an option of an answered question sends it to the agent as new input | —<sup>[4](#note-4)</sup> | —<sup>[5](#note-5)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| a message while a question without free text is pending withdraws it, and the next message gets a reply | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Tool approvals

| Rule | `tui` | `web chat` | `chat-sdk` | `chat-sdk-dm` | `chat-sdk-text` | `discord` | `discord-dm` | `linq` | `linq-dm` | `slack` | `slack-dm` | `teams` | `teams-dm` | `telegram` | `telegram-dm` | `github` | `linear` | `photon` | `twilio` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| a tool approval shows the tool's prompt with a choice to approve and one to cancel | ✅ | ✅ | ✅ |  | ✅ | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |
| pressing Approve runs the gated tool | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| pressing Cancel stops the gated tool without running it | ✅ | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| a text reply of approve runs the gated tool | —<sup>[6](#note-6)</sup> | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| a text reply of cancel stops the gated tool without running it | —<sup>[6](#note-6)</sup> | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing Approve twice runs the gated tool once | ✅ | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| pressing Approve on one of two pending approvals runs only that tool | ✅ | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| text replies answer two pending approvals one at a time, in the order shown | —<sup>[6](#note-6)</sup> | —<sup>[7](#note-7)</sup> | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ❌<sup>[8](#note-8)</sup> | ❌<sup>[8](#note-8)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| answering an approval and a question pending together settles both | ✅ | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| text replies answer a question and an approval raised together, in the order shown | —<sup>[6](#note-6)</sup> | ✅ | ✅ |  | ✅ | —<sup>[2](#note-2)</sup> |  | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |
| a message while an approval is pending cancels it, so typing approve afterwards runs nothing and the next message gets a reply | —<sup>[6](#note-6)</sup> | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing Approve on an approval a message cancelled runs nothing | —<sup>[6](#note-6)</sup> | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |

## Approval permissions

| Rule | `tui` | `web chat` | `chat-sdk` | `chat-sdk-dm` | `chat-sdk-text` | `discord` | `discord-dm` | `linq` | `linq-dm` | `slack` | `slack-dm` | `teams` | `teams-dm` | `telegram` | `telegram-dm` | `github` | `linear` | `photon` | `twilio` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| the requester typing approve on a requester-only approval runs the tool | —<sup>[6](#note-6)</sup> | ✅ | ✅ |  | ✅ | —<sup>[2](#note-2)</sup> |  | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |
| another person pressing Cancel or Approve on a requester-only approval leaves it pending | —<sup>[9](#note-9)</sup> | —<sup>[9](#note-9)</sup> | ✅ |  | —<sup>[10](#note-10)</sup> | ✅ |  | —<sup>[10](#note-10)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[10](#note-10)</sup> | —<sup>[10](#note-10)</sup> |
| another person typing cancel or approve doesn't settle a requester-only approval | —<sup>[9](#note-9)</sup> | —<sup>[9](#note-9)</sup> | ✅ |  | —<sup>[9](#note-9)</sup> | —<sup>[2](#note-2)</sup> |  | —<sup>[9](#note-9)</sup> |  | ✅ |  | ✅ |  | ✅ |  | ✅ | ✅ | —<sup>[9](#note-9)</sup> | —<sup>[9](#note-9)</sup> |
| another person's rejected press leaves the approval's buttons in place | —<sup>[9](#note-9)</sup> | —<sup>[9](#note-9)</sup> | ✅ |  | —<sup>[10](#note-10)</sup> | ✅ |  | —<sup>[10](#note-10)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[10](#note-10)</sup> | —<sup>[10](#note-10)</sup> |
| another person pressing Approve on an open approval runs the tool | —<sup>[9](#note-9)</sup> | —<sup>[9](#note-9)</sup> | ✅ |  | —<sup>[10](#note-10)</sup> | ✅ |  | —<sup>[10](#note-10)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[10](#note-10)</sup> | —<sup>[10](#note-10)</sup> |

## Answered prompts

| Rule | `tui` | `web chat` | `chat-sdk` | `chat-sdk-dm` | `chat-sdk-text` | `discord` | `discord-dm` | `linq` | `linq-dm` | `slack` | `slack-dm` | `teams` | `teams-dm` | `telegram` | `telegram-dm` | `github` | `linear` | `photon` | `twilio` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| pressing an option clears the question's buttons | ✅ | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| answering a question by text clears its buttons | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| pressing an option names who answered on the question | —<sup>[12](#note-12)</sup> | —<sup>[13](#note-13)</sup> | ❌<sup>[14](#note-14)</sup> |  | —<sup>[1](#note-1)</sup> | ❌<sup>[14](#note-14)</sup> |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ❌<sup>[14](#note-14)</sup> |  | ❌<sup>[14](#note-14)</sup> |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| answering a question by text names who answered on the question | —<sup>[12](#note-12)</sup> | —<sup>[13](#note-13)</sup> | ❌<sup>[14](#note-14)</sup> | ❌<sup>[14](#note-14)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[11](#note-11)</sup> | ❌<sup>[14](#note-14)</sup> | ❌<sup>[14](#note-14)</sup> | ❌<sup>[14](#note-14)</sup> | ❌<sup>[14](#note-14)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| pressing Approve clears the approval's buttons | ✅ | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| approving by text clears the approval's buttons | —<sup>[6](#note-6)</sup> | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| pressing Approve names who approved on the approval | —<sup>[12](#note-12)</sup> | —<sup>[13](#note-13)</sup> | ❌<sup>[14](#note-14)</sup> |  | —<sup>[1](#note-1)</sup> | ❌<sup>[14](#note-14)</sup> |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ❌<sup>[14](#note-14)</sup> |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| approving by text names who approved on the approval | —<sup>[6](#note-6)</sup> | —<sup>[13](#note-13)</sup> | ❌<sup>[14](#note-14)</sup> | ❌<sup>[14](#note-14)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ✅ | ✅ | ❌<sup>[14](#note-14)</sup> | ❌<sup>[14](#note-14)</sup> | ❌<sup>[14](#note-14)</sup> | ❌<sup>[14](#note-14)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |

## Inactive prompts

| Rule | `tui` | `web chat` | `chat-sdk` | `chat-sdk-dm` | `chat-sdk-text` | `discord` | `discord-dm` | `linq` | `linq-dm` | `slack` | `slack-dm` | `teams` | `teams-dm` | `telegram` | `telegram-dm` | `github` | `linear` | `photon` | `twilio` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| pressing Approve after the session's run ended outside eve runs nothing and clears the approval's buttons | ✅ | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| pressing an option after the session's run ended outside eve clears the question's buttons | ✅ | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| pressing an option after the session's run ended outside eve tells the person it is no longer active | ✅ | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| a question pressed after the session's run ended outside eve keeps its prompt and says it is no longer active | ✅ | ✅ | ❌<sup>[15](#note-15)</sup> |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |

## Budget prompts

| Rule | `tui` | `web chat` | `chat-sdk` | `chat-sdk-dm` | `chat-sdk-text` | `discord` | `discord-dm` | `linq` | `linq-dm` | `slack` | `slack-dm` | `teams` | `teams-dm` | `telegram` | `telegram-dm` | `github` | `linear` | `photon` | `twilio` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| running out of budget opens budget prompt | ✅ | ✅ | ✅ |  | ✅ | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |
| pressing approve on budget prompt allows agent to continue | ✅ | ✅ | ✅ |  | —<sup>[1](#note-1)</sup> | ✅ |  | —<sup>[1](#note-1)</sup> |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| reply of approve on budget prompt allows agent to continue | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| pressing stop on budget prompt halts work, next message asks again | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> |
| reply of stop on budget prompt halts work, next message asks again | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| query sent during budget prompt answered after budget approval | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Sign-ins

| Rule | `tui` | `web chat` | `chat-sdk` | `chat-sdk-dm` | `chat-sdk-text` | `discord` | `discord-dm` | `linq` | `linq-dm` | `slack` | `slack-dm` | `teams` | `teams-dm` | `telegram` | `telegram-dm` | `github` | `linear` | `photon` | `twilio` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| a sign-in names the service and shows its sign-in link | ✅ | ✅ | ✅ | ✅ | ✅ | ❌<sup>[16](#note-16)</sup> | ❌<sup>[16](#note-16)</sup> | ❌<sup>[17](#note-17)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[18](#note-18)</sup> | ✅ | ✅ | ✅ |
| a sign-in shows its confirmation code | ✅ | ✅ | ✅ | ✅ | ✅ | ❌<sup>[16](#note-16)</sup> | ❌<sup>[16](#note-16)</sup> | ❌<sup>[17](#note-17)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[18](#note-18)</sup> | ✅ | ✅ | ✅ |
| only the person signing in sees the sign-in link and code | —<sup>[19](#note-19)</sup> | —<sup>[19](#note-19)</sup> | ✅ | —<sup>[19](#note-19)</sup> | —<sup>[19](#note-19)</sup> | ✅ | —<sup>[19](#note-19)</sup> | ✅ | —<sup>[19](#note-19)</sup> | ✅ | —<sup>[19](#note-19)</sup> | ✅ | —<sup>[19](#note-19)</sup> | ✅ | —<sup>[19](#note-19)</sup> | ✅ | ❌<sup>[20](#note-20)</sup> | —<sup>[19](#note-19)</sup> | —<sup>[19](#note-19)</sup> |
| someone else pressing a sign-in isn't shown its link or code | —<sup>[9](#note-9)</sup> | —<sup>[9](#note-9)</sup> | —<sup>[21](#note-21)</sup> | —<sup>[9](#note-9)</sup> | —<sup>[10](#note-10)</sup> | —<sup>[22](#note-22)</sup> | —<sup>[9](#note-9)</sup> | —<sup>[10](#note-10)</sup> | —<sup>[10](#note-10)</sup> | —<sup>[21](#note-21)</sup> | —<sup>[9](#note-9)</sup> | ✅ | —<sup>[9](#note-9)</sup> | ✅ | —<sup>[9](#note-9)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[1](#note-1)</sup> | —<sup>[10](#note-10)</sup> | —<sup>[10](#note-10)</sup> |
| a sign-in without a link shows its instructions | ✅ | ✅ | ✅ | ✅ | ✅ | ❌<sup>[16](#note-16)</sup> | ❌<sup>[16](#note-16)</sup> | ❌<sup>[17](#note-17)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌<sup>[16](#note-16)</sup> | ✅ | ✅ | ✅ |
| after signing in, the agent carries on with the request | ✅ | ✅ | ✅ |  | ✅ | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ | ✅ | ✅ | ✅ |
| completing a sign-in tells the person it succeeded | ✅ | ✅ | ✅ | ✅ | ✅ | ❌<sup>[16](#note-16)</sup> | ❌<sup>[16](#note-16)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌<sup>[16](#note-16)</sup> | ✅ | ✅ | ✅ |
| message after ignored sign-in gets an answer, signing in late doesn't run | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| message after ignored sign-in tells user it was cancelled | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[2](#note-2)</sup> | —<sup>[2](#note-2)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌<sup>[16](#note-16)</sup> | ✅ | ✅ | ✅ |

## Tool callers

| Rule | `tui` | `web chat` | `chat-sdk` | `chat-sdk-dm` | `chat-sdk-text` | `discord` | `discord-dm` | `linq` | `linq-dm` | `slack` | `slack-dm` | `teams` | `teams-dm` | `telegram` | `telegram-dm` | `github` | `linear` | `photon` | `twilio` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| a tool sees the person who sent the message as its caller | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| another person's message reaches tools as a different caller, and each person stays the same caller | —<sup>[9](#note-9)</sup> | —<sup>[9](#note-9)</sup> | ✅ |  | —<sup>[9](#note-9)</sup> | ✅ |  | —<sup>[9](#note-9)</sup> |  | ✅ |  | ✅ |  | ✅ |  | ✅ | ✅ | —<sup>[9](#note-9)</sup> | —<sup>[9](#note-9)</sup> |

## Attachments

| Rule | `tui` | `web chat` | `chat-sdk` | `chat-sdk-dm` | `chat-sdk-text` | `discord` | `discord-dm` | `linq` | `linq-dm` | `slack` | `slack-dm` | `teams` | `teams-dm` | `telegram` | `telegram-dm` | `github` | `linear` | `photon` | `twilio` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| an image a person sends reaches the agent with its bytes and type | —<sup>[23](#note-23)</sup> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | —<sup>[23](#note-23)</sup> | ✅ | ✅ | ✅ |
| a PDF a person sends reaches the agent with its bytes and type | —<sup>[23](#note-23)</sup> | ✅ | ✅ |  | ✅ | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[23](#note-23)</sup> | ✅ | ✅ | ✅ |
| a file that can't be downloaded reaches the agent as a note, not a link, and the next message still works | —<sup>[23](#note-23)</sup> | —<sup>[24](#note-24)</sup> | ✅ |  | ✅ | ✅ |  | ✅ |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[23](#note-23)</sup> | ✅ | ✅ | ✅ |
| a file sent earlier in the conversation is still there on a later message | —<sup>[23](#note-23)</sup> | ✅ | ✅ |  | ✅ | —<sup>[25](#note-25)</sup> |  | ✅ |  | ✅ |  | ✅ |  | ✅ |  | —<sup>[23](#note-23)</sup> | ✅ | ✅ | ✅ |

## Notes

1. <a id="note-1"></a>the platform has no buttons a person can press
2. <a id="note-2"></a>the platform has no plain-text replies
3. <a id="note-3"></a>each open request has its own drawer, and typing a message dismisses them all
4. <a id="note-4"></a>an answered question's drawer closes, so nothing is left to press
5. <a id="note-5"></a>an answered question disables its options, so nothing is left to press
6. <a id="note-6"></a>the approval drawer holds the keyboard; a person answers it with y or n
7. <a id="note-7"></a>a reply sent while approvals wait goes out as a steering message, which sometimes restarts the turn instead of answering
8. <a id="note-8"></a>one card shows every approval a step raises, so a typed reply can't say which it answers
9. <a id="note-9"></a>the platform has no second person who can act
10. <a id="note-10"></a>the platform has no second person who can act or buttons a person can press
11. <a id="note-11"></a>only the button interaction handler edits a question; a typed answer leaves it
12. <a id="note-12"></a>one person answers at their own terminal; there's nobody else to tell
13. <a id="note-13"></a>one person answers in their own browser tab; there's nobody else to tell
14. <a id="note-14"></a>a resolved prompt doesn't say who answered; input.resolved carries no responder
15. <a id="note-15"></a>a press carries only the card's message id, and the session that knew its prompt is gone, so the retired card shows only how it ended
16. <a id="note-16"></a>the channel has no default sign-in renderer
17. <a id="note-17"></a>Linq's openDM needs the person's phone handle, but a message names its sender by an opaque handle id, so the bot can only say to continue in a direct message
18. <a id="note-18"></a>the rule applies only where the conversation is shared or private, and this one is public
19. <a id="note-19"></a>the rule applies only where the conversation is public or shared, and this one is private
20. <a id="note-20"></a>the code is in the elicitation body the whole issue sees; who sees the auth signal's link is unverified
21. <a id="note-21"></a>the sign-in goes privately to the person signing in, so the thread shows nothing to press
22. <a id="note-22"></a>the channel shows no sign-in, so there's nothing to press
23. <a id="note-23"></a>the platform has no files a person can send
24. <a id="note-24"></a>the browser sends a file's bytes with the message, so there is no download to fail
25. <a id="note-25"></a>each slash command starts its own session, so no later message shares one with the file
