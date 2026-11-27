# eve package artifacts

The `eve-pkg` Vercel project builds and publishes tarballs for every public package in `packages/` (each one `changeset publish` releases to npm) to private Vercel Blob using deployment OIDC. Its production domain, `pkg.eve.dev`, serves both `main` and same-repository pull-request packages.

Each package is named like its `npm pack` tarball, without the version: `eve` is `eve.tgz`, `@eve/recall` is `eve-recall.tgz`, and `@vercel/agent-runs` is `vercel-agent-runs.tgz`.

```text
/main/<package>.tgz
/main/latest.json
/pr/<number>/<package>.tgz
/pr/<number>/latest.json
/<full-sha>/<package>.tgz
```

Initialize an agent from the current `main` build with:

```bash
npm exec --yes --package=https://pkg.eve.dev/main/eve.tgz -- eve init my-agent
```

A same-repository pull-request build is available after its **Vercel – eve-pkg** deployment succeeds, including when the pull request targets another branch in a stack. Fork pull requests and direct branch deployments never build or publish package artifacts. For example:

```bash
npm exec --yes --package=https://pkg.eve.dev/pr/123/eve.tgz -- eve init my-agent
```

Install an extension next to the eve build from the same ref so its `eve` peer dependency resolves to that build:

```bash
npm install https://pkg.eve.dev/pr/123/eve.tgz https://pkg.eve.dev/pr/123/eve-recall.tgz
```

Moving routes redirect to immutable `/<sha>/<package>.tgz` artifacts. The packaged CLI also stamps the immutable eve URL into generated projects. `latest.json` lists every package of a ref under `packages`, and keeps eve's `version`, `tarball`, and `sha256` at the top level.

## Publishing

Vercel deploys `main` to Production and same-repository pull requests to Preview. The build derives the source SHA and PR number from Vercel system environment variables, builds and packs every package in `packages/` whose `package.json` is not `private`, verifies that the source still represents the current branch or pull-request head, and writes the following objects:

```text
packages/<sha>/<package>.tgz
packages/<sha>/manifest.json
packages/refs/main.json
packages/refs/pr/<number>.json
```

SHA objects are immutable. Main and PR pointer objects are mutable, short-cached, and updated once per build, so all packages of a ref always come from the same commit.

The build requires `VERCEL_OIDC_TOKEN` and `BLOB_STORE_ID` and passes them explicitly to the Blob SDK. It does not accept or use a static Blob write token.

The build also reads an optional `GITHUB_TOKEN`, a read-only token for `vercel/eve`. When set, preview builds send it as a bearer token on their GitHub API requests, so they use the token's rate limit and not GitHub's shared 60 requests per hour limit for unauthenticated addresses.

## Project setup

The `eve-pkg` Vercel project must:

- use this directory as its project root;
- enable Vercel system environment variables and OIDC;
- connect the private package Blob store to Production and Preview;
- deploy `main` to Production;
- omit `BLOB_READ_WRITE_TOKEN` from Production and Preview;
- disable Deployment Protection so package managers can reach the production proxy; and
- use the following trusted Ignored Build Step:

```sh
if [ "$VERCEL_ENV" = "production" ]; then
  test "$VERCEL_GIT_COMMIT_REF" != "main"
else
  test "$VERCEL_ENV" != "preview" ||
    test "$VERCEL_GIT_REPO_OWNER" != "vercel" ||
    test "$VERCEL_GIT_REPO_SLUG" != "eve" ||
    test -z "$VERCEL_GIT_PULL_REQUEST_ID"
fi
```

Vercel interprets exit code `0` as “skip this build.” The command therefore permits only production `main` and same-repository PR Preview deployments, rejecting forks before dependency installation. The build repeats the repository and deployment checks as defense in depth.

Same-repository PR code runs with package-store OIDC access during its Preview build. This is acceptable only while write access to `vercel/eve` is restricted to trusted employees. The Blob store must remain package-only and must not contain unrelated application data.

The smoke check verifies public access and the downloaded main artifact's gzip signature.
