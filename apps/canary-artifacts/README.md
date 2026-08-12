# eve canary artifacts

Static Vercel project that builds and serves an installable `eve` tarball from every checked-out commit, following `vercel/workflow`'s tarball project pattern.

Each deployment serves:

```text
/canary/eve.tgz
/canary/manifest.json
```

The production alias is the convenient latest entry point:

```bash
npm exec --yes --package=https://<production-alias>/canary/eve.tgz -- eve init my-agent
```

The packaged CLI knows the immutable `VERCEL_URL` of the deployment that built it, so generated projects pin that exact deployment URL rather than the moving production alias.

The Vercel project must use this directory as its project root and disable Deployment Protection so npm can download tarballs. The smoke check verifies public access and the gzip signature.
