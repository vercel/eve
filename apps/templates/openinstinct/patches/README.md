# Dependency compatibility patches

eve is pinned to the published `1.0.0-rc.17` release.

`@linqapp__chat-sdk-adapter@0.5.1.patch` adds the native reply option to
the separately installed adapter while preserving attachments and idempotency.
The application delivery tests exercise that adapter.

Native Linq replies use the separately installed, patched adapter directly.
eve's bundled adapter does not forward a reply target. Keeping the patch on
the application dependency preserves attachments and idempotency without an
exact-version patch on eve, so packed framework compatibility checks can
replace eve normally. The inbound channel still uses eve's adapter and auth.

The earlier `task_cancel` hunk is no longer needed: Eve 1.0 provides
`eve__task_cancel` itself for agents with task tools, including the resumable
`run_browser` tool.

Stripe Link purchases are disabled on this branch. No published
`@stripe/link-integrations-eve` release is built for Eve 1.0 (0.3.8 was built
with 0.79.0), and Eve 1.0 refuses to load extensions built with 0.83 or
earlier. See the README's Link wallet section for how to re-enable it.
