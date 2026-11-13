# Dependency compatibility patches

Eve is pinned to the published `1.0.0-rc.1` release.

`@linqapp__chat-sdk-adapter@0.5.1.patch` adds the native reply option to
the separately installed adapter while preserving attachments and idempotency.
The application delivery tests exercise that adapter.

`eve@1.0.0-rc.1.patch` preserves native Linq replies. Eve bundles its own copy
of the Linq Chat SDK adapter, which does not forward a reply target. The patch
adds `replyToMessageId` to the bundled adapter's `LinqSendOptions` and forwards
it to Linq as `reply_to`, matching the installed adapter patch above. Remove it
when an Eve release's bundled adapter supports native replies.

The earlier `task_cancel` hunk is no longer needed: Eve 1.0 provides
`eve__task_cancel` itself for agents with task tools, including the resumable
`run_browser` tool.

Stripe Link purchases are disabled on this branch. No published
`@stripe/link-integrations-eve` release is built for Eve 1.0 (0.3.8 was built
with 0.79.0), and Eve 1.0 refuses to load extensions built with 0.83 or
earlier. See the README's Link wallet section for how to re-enable it.
