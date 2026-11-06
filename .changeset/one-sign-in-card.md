---
"eve": patch
---

Parallel subagents that need the same Vercel Connect grant for the same person now show one sign-in card in the parent.

Completing that sign-in completes every subagent waiting on it: the parent calls each one's own callback, and each reads the stored grant for its own principal. If the subagent whose card is shown stops waiting, the card moves to the next one still waiting. Sign-ins without a grant, for another principal, or minted by another deployment keep their own card.
