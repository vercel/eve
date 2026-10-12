---
"eve": minor
---

Answers to approvals stand as response rows as they arrive, and a step's approvals settle together
from them.

- A partial answer to a batch of approvals stands, admitted, until the rest arrive; it is no longer
  queued as input.
- Approved calls run as soon as their batch settles, before the next model call's budget check.
- A message that steers past pending approvals settles the answered ones on their answers and
  withdraws every unanswered one, not only the first batch's.
- A message waits behind the budget prompt only; every other interaction gives way to it.
- An answer a response policy weighs stays `response.submitted` until the policy allows it
  (`response.admitted`) or refuses it (`response.settled`), and an approval whose tool went away
  is withdrawn as soon as its policy finds it gone.
