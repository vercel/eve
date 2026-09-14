# eve package artifacts

A stable, read-only Vercel app at `pkg.eve.dev` proxies private Blob artifacts published by GitHub Actions. The app itself never packages source or writes Blob objects.

```text
/main/eve.tgz
/main/latest.json
/pr/<number>/eve.tgz
/pr/<number>/latest.json
/<full-sha>/eve.tgz
```

Initialize an agent from the current `main` build with:

```bash
npm exec --yes --package=https://pkg.eve.dev/main/eve.tgz -- eve init my-agent
```

A pull-request build is available at `/pr/<number>/eve.tgz` after its package workflow succeeds. Both moving routes redirect to an immutable `/<sha>/eve.tgz` artifact, and the packaged CLI stamps that immutable URL into generated projects.

## Publishing

[Package artifact build](../../.github/workflows/package-artifact-build.yml) runs for `main` pushes and pull requests without credentials. It checks out the exact source SHA, packages eve, and uploads the tarball and metadata as a short-lived GitHub Actions artifact.

[Package artifact publish](../../.github/workflows/package-artifact-publish.yml) publishes `main` automatically through `workflow_run`. Pull requests require a manual `workflow_dispatch` with the PR number. The default branch selection runs the publisher from trusted `main`; intentionally selecting another branch runs that branch's publisher with the Blob credential for testing. The publisher resolves the PR's current head through the API, finds that SHA's successful package build, downloads its artifact, and uploads the bytes without executing or extracting them.

The publisher writes:

```text
packages/<sha>/eve.tgz
packages/<sha>/manifest.json
packages/refs/main.json
packages/refs/pr/<number>.json
```

SHA objects are immutable. Main and PR pointer objects are mutable and short-cached.

## Project setup

The Vercel package project must:

- use this directory as its project root;
- connect the private package Blob store for reads;
- deploy `main` to Production;
- set its Ignored Build Step to `test "$VERCEL_GIT_COMMIT_REF" != "main"`; and
- disable Deployment Protection so package managers can reach the public proxy.

Set the repository Actions secret `EVE_PACKAGE_BLOB_READ_WRITE_TOKEN` to the package store's write token. The build workflow never references this secret. Pull-request builds inherit the repository's existing contributor approval policy, and publishing a PR requires a separate manual run of **Package artifact publish**. Leave **Use workflow from** set to `main` for the normal trusted publisher; selecting another branch explicitly grants that branch's publisher access to the Blob credential.

The smoke check verifies public access and the downloaded main artifact's gzip signature.
