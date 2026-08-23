---
"@eve/self-modification": patch
---

The self-modification subagent can now search the eve registry. A new
`selfmod__search_registry` tool reports the channels, MCP connections,
extensions, and observability integrations a project can add — each with its
item address, whether the authored tree already holds it, and the eve version it
requires — so the subagent recommends `eve add channel/slack` instead of
hand-writing an integration the registry already ships. Search is read-only and
installs nothing. Results include pagination metadata so every match can be
retrieved, and bundle searches include their component names and metadata.
