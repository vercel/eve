# @eve/slack-reactions Extension Package

This private package is the source of the `eve/extensions/slack-reactions` extension. It contributes the `react_with_emoji` and `remove_emoji_reaction` tools, offered on Slack turns and acting on messages in the current conversation.

Before writing code, read the installed eve package docs for extensions, tools, and the Slack channel as applicable.

## Boundaries

- Keep the tools Slack-only: the dynamic resolvers return `null` unless the session's channel resolves to a reaction scope.
- Call Slack through `callSlackApi` from `eve/channels/slack` with the mount's `credentials` and `api`, so reactions use the same token and host as the agent's Slack channel.
- Keep shared implementation under `extension/lib/`; filesystem paths define contribution names.

## Build and publish

The eve build copies `extension/` into `packages/eve/src/extensions/slack-reactions/extension` and compiles it into the `eve` package; public entry points are declared in `packages/eve/package.json`. Do not publish this package or add it as an eve dependency (it depends on eve). Import only public `eve/*` APIs from `extension/`; third-party imports are bundled into eve's dist. Keep tests under `test/unit/` and `test/integration/`, outside the discovered extension tree. Run typecheck, both test tiers, eve's build, lint, and package-scoped formatting before completion.
