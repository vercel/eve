---
"eve": patch
---

Fix compiling agents on Windows when a mounted extension contributes a subagent. Each subagent's workspace resources now live in one URL-encoded directory under `.eve/compile/workspace-resources/`, so ids that contain `:` no longer produce invalid Windows paths.
