# Template runtime

Private implementation of the eve Expo Chat Template's dashboard, app APIs, notification outbox, SQLite service, and local/cloud browser integration.

This package ships as source inside the template and is linked from its root `package.json`. Run `pnpm build:runtime` from the template root to generate assets and compile the extension. It does not require an npm publication, relay service, or another checkout.

See the template [README](../../README.md) and [setup guide](../../docs/standalone-template.md). Customize the mount in `agent/extensions/start.ts`; setup is owned by the template's `scripts/setup.sh`.
