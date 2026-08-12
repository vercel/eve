# eve canary artifacts

Static Vercel project that builds a canary tarball from each checked-out `vercel/eve` commit, uploads an immutable SHA-addressed artifact to public Vercel Blob using deployment OIDC, and serves a convenient latest pointer.

```text
/canary/latest
/canary/latest.json
/canary/<full-sha>/eve.tgz
```

Generated projects pin the immutable public Blob URL. The deployment's static `/canary/latest` tarball is only for acquiring the current canary CLI.

The Vercel project must:

- use this directory as its project root;
- connect a public Blob store to Production;
- set `BLOB_STORE_ID`;
- omit `BLOB_READ_WRITE_TOKEN` so Blob writes use Vercel OIDC;
- disable Deployment Protection so npm can download tarballs.
