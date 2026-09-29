---
"eve": patch
---

Session workflow steps now return only the session state they changed, and the workflow applies that change to the state it passed in. Each step used to return a full copy of the session, so stored step output and the data a workflow replay reads grew with conversation length on every step; they now grow only with what each step changes.
