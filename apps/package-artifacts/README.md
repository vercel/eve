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

A pull-request build is available at `/pr/<number>/eve.tgz` after its **Package artifact** commit status succeeds. That status is reported only after publication finishes, and no manual publishing step is required. Both moving routes redirect to an immutable `/<sha>/eve.tgz` artifact, and the packaged CLI stamps that immutable URL into generated projects.

For example, after the package check passes on PR #123:

```bash
npm exec --yes --package=https://pkg.eve.dev/pr/123/eve.tgz -- eve init my-agent
```

## Publishing

[Package artifact build](../../.github/workflows/package-artifact-build.yml) runs for `main` pushes and pull requests without credentials. It checks out the exact source SHA, packages eve, and uploads the tarball and metadata as a short-lived GitHub Actions artifact.

[Package artifact publisher](../../.github/workflows/package-artifact-publish.yml) is an automatic internal trust boundary. GitHub loads it from the default branch on successful package builds. It verifies that the build still represents the current `main` or pull-request head, downloads the artifact on a fresh runner, and uploads the bytes without executing or extracting them. It then reports the user-facing **Package artifact** commit status. Keeping publishing separate prevents pull-request code from changing the credentialed workflow or reading the Blob token.

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

Set the repository Actions secret `EVE_PACKAGE_BLOB_READ_WRITE_TOKEN` to the package store's write token. The user-facing workflow never references this secret. Pull-request builds inherit the repository's existing contributor approval policy, and successful builds publish automatically through the trusted default-branch publisher.

The smoke check verifies public access and the downloaded main artifact's gzip signature.
