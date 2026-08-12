# eve package artifacts

Git-linked Vercel project that builds an eve tarball from every checked-out `vercel/eve` branch commit and uploads an immutable SHA-addressed artifact to public Vercel Blob using deployment OIDC.

```text
/<branch>/eve.tgz
/<branch>/latest.json
/<full-sha>/eve.tgz
```

For example, to initialize an agent from the current `main` build:

```bash
npm exec --yes --package=https://pkg.eve.dev/main/eve.tgz -- eve init my-agent
```

A branch URL resolves to its current commit. Its `latest.json` returns the build manifest, including `sourceSha`. The packaged CLI stamps the immutable commit URL into generated projects.

The Vercel project must:

- use this directory as its project root;
- connect a public Blob store to Production;
- omit `BLOB_READ_WRITE_TOKEN` so Blob writes use Vercel OIDC; and
- disable Deployment Protection so npm can reach `pkg.eve.dev` anonymously.

The smoke check verifies public access and the downloaded artifact's gzip signature.
