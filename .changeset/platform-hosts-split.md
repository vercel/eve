---
"eve": patch
---

eve splits its process registry into hook routes and session streams, so each part of eve reads only the part it uses, and an engine registers its routes and streams for the life of its app.
