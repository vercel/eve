# `git.deploymentEnabled` repro

This fixture isolates [#438](https://github.com/vercel/eve/issues/438): creating an eve project with the eve CLI does not forward the repository's root `vercel.ts` `git.deploymentEnabled` configuration to the Vercel project.

The three apps share this repository and the same root [`vercel.ts`](./vercel.ts). `web` and `docs` are identical minimal Next.js controls. The only meaningful difference is how their Vercel projects are created:

- `apps/web` and `apps/docs`: `vercel link`
- `apps/agent`: `eve link`

## Reproduce

These steps require a live Vercel team and GitHub repository. The resulting preview-deployment behavior cannot be observed purely locally.

1. Push this fixture to a GitHub repository whose default branch is `master`.
2. From `apps/web` and `apps/docs`, run `vercel link` and create one Vercel project for each app. This is the control path: the Vercel CLI reads the root `vercel.ts` configuration when it creates the projects.
3. From `apps/agent`, run `eve link` and create its Vercel project. This is the variable path under test.
4. Create a branch such as `feature/repro`, change a file in each app, commit, and push the branch.

## Expected and actual behavior

The root configuration enables deployments only for `master`, so all three projects should skip preview deployments for `feature/repro`.

Before the fix proposed in [#447](https://github.com/vercel/eve/pull/447), the controls behave as expected: `web` and `docs` are skipped. The agent project is created without the configuration, so it creates a deployment that later cancels or skips instead of being suppressed at the Git-integration decision.

To prove that project creation is the cause, delete and recreate the agent project with `vercel link` rather than `eve link`, then repeat step 4. The agent project is suppressed like the controls. That is the behavior #447 changes.
