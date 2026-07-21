# dist-extensions

Proves built extensions work when installed with a registry-style node_modules
layout.

The workspace `extensions` fixture consumes its extensions via `workspace:*`,
and pnpm links a workspace package's dependencies inside the package directory
— so bare imports in extension code (e.g. `import { z } from "zod"`) resolve
from anywhere. A registry install does not get that layout: pnpm copies the
package into the virtual store and its dependencies are store _siblings_, only
resolvable from the package's real location.

This fixture consumes `gizmo-extension` and `gadget-extension` with the
`file:` protocol, which makes pnpm copy them into the virtual store like
registry packages, reproducing the sibling-dependency layout without
publishing anything. Both packages are built with `eve extension build` before
evals run (the e2e workflows run the build and then refresh the install so the
store copies pick up the dist), so the fixture consumes them in their
published form: package entrypoints and an agent-shaped `dist/extension` tree,
with no author TypeScript in the store copy. The consuming eve discovers,
validates, and normalizes that dist tree.

Together with the `extensions` fixture this covers the matrix: gizmo is
consumed from the workspace there and store-installed here, toolkit stays
workspace-only, and gadget is store-installed only.

The fixture has no `typecheck` script: type resolution goes through the store
copies' generated declarations, which do not exist in jobs that skip the
extension build.
