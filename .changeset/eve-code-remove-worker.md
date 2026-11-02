---
"eve": major
---

The code extension (`eve/extensions/code`) no longer adds the read-only `code__worker` subagent, and `code()` rejects the `worker` option.

To migrate, remove `worker` from your `code()` mount and delegate with the core `agent` tool. If an `agent/tools/agent.ts` override disables `agent` so delegation goes to `code__worker`, delete the override. A mount that still passes `worker` fails with ``Invalid extension config: eve-code no longer ships a worker subagent; delegate with the core `agent` tool and remove the `worker` option.``

The `code__review` skill starts a fresh-context agent with a no-edit audit brief when one is available and otherwise audits in the current session. The `code__lookup-agent-run` skill and the internal `eve/internal/code/prwatch` export are removed.
