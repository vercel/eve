---
"eve": patch
---

Requests and turn steps no longer re-read and re-validate the agent's compile metadata each time they look up the compiled agent.

eve now remembers the version key for each installed bundle, and for compiled output on disk while its compile metadata file is unchanged.
