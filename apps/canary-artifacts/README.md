# eve canary artifacts

Git-linked Vercel project that builds a canary tarball from every checked-out `vercel/eve` commit and uploads an immutable SHA-addressed artifact to public Vercel Blob using deployment OIDC.

```text
/canary/latest
/canary/latest.json
/canary/<full-sha>/eve.tgz
```

The latest route is a convenient entry point:

```bash
npm exec --yes --package=https://<production-alias>/canary/latest -- eve init my-agent
```

The packaged CLI stamps the immutable public Blob URL into generated projects rather than the moving latest pointer.

The Vercel project must:

- use this directory as its project root;
- connect a public Blob store to Production;
- set `BLOB_STORE_ID`;
- omit `BLOB_READ_WRITE_TOKEN` so Blob writes use Vercel OIDC;
- disable Deployment Protection so npm can reach `/canary/latest` anonymously.

The smoke check verifies public access and the downloaded artifact's gzip signature.
