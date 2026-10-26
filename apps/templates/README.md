# Template source apps

These are standalone source projects for the eve template gallery. Each directory owns its `package.json`, `pnpm-lock.yaml`, and framework configuration so people can copy or deploy it without the eve workspace.

The [Company Brain Template](./eve-company-brain-template/README.md) adds a Slack agent backed by dbt models, with local DuckDB or MotherDuck selected by connection string. It is listed as **Company Brain** in the template gallery.

The root workspace intentionally excludes these projects. Do not use `workspace:` dependencies or import files from elsewhere in this repository. Keep `eve` as a normal npm dependency and update the template lockfile when its dependencies change.

Some templates copy files unchanged from `apps/docs/registry`, such as the eve Web Chat components, or from another template, such as the chat template's auth helpers. `scripts/sync-template-files.mjs` lists them; edit the source, not the copy. Run `pnpm sync:template-files` to update the copies; `pnpm check:template-files` fails in CI when a copy drifts or is not marked `linguist-generated` in `.gitattributes`.

Run `pnpm check:templates` from the repository root to install every template in a temporary directory against a packed local `eve` package, then run its `typecheck` and `build` scripts.
