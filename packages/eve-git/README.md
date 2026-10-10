# eve/extensions/git

`eve/extensions/git` is an eve extension for GitHub work. It contributes GitHub instructions and a `pr` skill and, with `github` config, an authenticated `gh` tool with signed commits.

It ships inside the `eve` package. This private `@eve/git` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/git/extension` and publishes it with these entry points:

- `eve/extensions/git`: the extension
- `eve/extensions/git/tools`: the `gh` tool, for agents that mount it directly
- `eve/extensions/git/sandbox`: GitHub shell execution, signed-commit, and guidance helpers

## Mount

```ts
// agent/extensions/git.ts
import git from "eve/extensions/git";

export default git({});
```

`git({})` assumes the agent's shell has GitHub credentials. The instructions point the agent at the `gh` and `git` CLIs in `bash`, and `git__pr` commits, pushes, and opens a draft with `gh pr create --draft`. No tool is contributed.

To broker GitHub access through Connect instead, configure `github` with `connector`, `org`, and a required `broker(sandbox, rules)` callback. The extension then contributes `git__gh`, which requests a token for exactly one repository in that organization per command. The callback installs the supplied GitHub header-transform rules for the command, then receives `null` to remove the lease. It must preserve the consumer's other network rules. Sandbox processes receive a placeholder token, not the real credential. `git__pr` switches to `gh-signed-commit` for repositories that require verified signatures. Install the executables with `installCodeTooling` from `eve/extensions/code/sandbox`.

## Validate

```sh
pnpm --filter @eve/git typecheck
pnpm --filter @eve/git test
pnpm --filter @eve/git test:scenario
```
