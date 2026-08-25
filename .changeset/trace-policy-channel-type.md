---
"eve": patch
---

Trace capture policies now receive the originating channel's type, letting a policy sample by channel (for example retaining interactive traffic while dropping scheduled runs). Policies that ignore the field are unaffected.
