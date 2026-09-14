# Template source apps

These are standalone source projects for the eve template gallery. Each directory owns its `package.json`, `pnpm-lock.yaml`, and framework configuration so people can copy or deploy it without the eve workspace.

The root workspace intentionally excludes these projects. Do not use `workspace:` dependencies or import files from elsewhere in this repository. Keep `eve` as a normal npm dependency and update the template lockfile when its dependencies change.

Run `pnpm check:templates` from the repository root to install every template in a temporary directory against a packed local `eve` package, then run its `typecheck` and `build` scripts.
