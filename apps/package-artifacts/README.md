# eve package artifacts

The `eve-pkg` Vercel project builds and publishes eve tarballs to private Vercel Blob using deployment OIDC. Its production domain, `pkg.eve.dev`, serves both `main` and same-repository pull-request packages.

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

A same-repository pull-request build is available after its **Vercel – eve-pkg** deployment succeeds. Fork pull requests and direct branch deployments never build or publish package artifacts. For example:

```bash
npm exec --yes --package=https://pkg.eve.dev/pr/123/eve.tgz -- eve init my-agent
```

Both moving routes redirect to an immutable `/<sha>/eve.tgz` artifact. The packaged CLI also stamps that immutable URL into generated projects.

## Publishing

Vercel deploys `main` to Production and same-repository pull requests to Preview. The build derives the source SHA and PR number from Vercel system environment variables, packages eve, verifies that the source still represents the current branch or pull-request head, and writes the following objects:

```text
packages/<sha>/eve.tgz
packages/<sha>/manifest.json
packages/refs/main.json
packages/refs/pr/<number>.json
```

SHA objects are immutable. Main and PR pointer objects are mutable and short-cached.

The build requires `VERCEL_OIDC_TOKEN` and `BLOB_STORE_ID` and passes them explicitly to the Blob SDK. It does not accept or use a static Blob write token.

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
