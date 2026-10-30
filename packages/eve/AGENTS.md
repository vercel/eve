# eve

Guidance for coding agents building with eve. Paths are relative to this
package (`node_modules/eve/`).

1. Read `docs/quick-reference.md` first. It has a typechecked snippet for each
   common requirement: tools, approvals, Slack, SSO, MCP and OpenAPI
   connections, per-user tools, subagents, skills, schedules, webhooks,
   memory, evals, and what agents get by default.
2. For anything else, `docs/README.md` routes to the right page.
3. Pages are long. List a page's sections with `grep -n '^#' <page>` and read
   only the sections you need.

No project yet? Run `npx eve@latest init <name>` and follow the instructions
it prints.
