# eve package artifacts

Git-linked Vercel project that builds an eve tarball from each `vercel/eve` `main` commit and uploads immutable SHA-addressed package and manifest artifacts to public Vercel Blob using deployment OIDC.

```text
/main/eve.tgz
/main/latest.json
/<full-sha>/eve.tgz
```

For example, to initialize an agent from the current `main` build:

```bash
npm exec --yes --package=https://pkg.eve.dev/main/eve.tgz -- eve init my-agent
```

The production deployment resolves `main` to its checked-out commit. Its `latest.json` exposes metadata for that package, including the source SHA, immutable Blob URL, and checksum. The packaged CLI stamps its immutable commit URL into generated projects, so a project created through the moving `main` URL remains pinned to the package used to create it.

The Vercel project must:

- use this directory as its project root;
- deploy `main` to Production;
- connect a public Blob store to Production;
- omit `BLOB_READ_WRITE_TOKEN` so Blob writes use Vercel OIDC; and
- disable Deployment Protection so npm can reach `pkg.eve.dev` anonymously.

Only production builds of `main` publish artifacts. Other builds produce a placeholder deployment; configure the project's Ignored Build Step as `test "$VERCEL_GIT_COMMIT_REF" != "main"` to skip non-`main` deployments before install and build. The smoke check verifies public access and the downloaded artifact's gzip signature.
