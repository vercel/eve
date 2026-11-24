---
"eve": patch
---

eve's session engines now give the session stream only as a stream sink, and the session program hands a step its key and signals as part of its step meta instead of a separate run argument.
