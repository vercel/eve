---
"eve": minor
---

Remove the microsandbox sandbox provider. The `eve/sandbox/microsandbox` export and the `microsandbox` option on `DefaultSandbox.environment()` are gone, and `DefaultSandbox` now selects Vercel Sandbox on Vercel, then Docker when a daemon is reachable, then just-bash. To migrate, switch `MicrosandboxSandbox.image()` and `MicrosandboxSandbox.dockerfile()` to `DockerSandbox.image()` and `DockerSandbox.dockerfile()` from `eve/sandbox/docker`, and remove the `microsandbox` dependency. A session that recorded a microsandbox sandbox starts a fresh sandbox from its current provider on its next `ctx.getSandbox()`.

eve no longer cleans up what microsandbox left on your machine. Before you uninstall `microsandbox`, use its tooling to remove sandboxes and snapshots whose names start with `eve-sbx-`. Then delete `.eve/sandbox-cache/microsandbox` in each app. If you used `MicrosandboxSandbox.dockerfile()`, also run `docker rm -f eve-sandbox-registry` to remove the local image registry it started, and remove the local images tagged `127.0.0.1:51921/eve/…`.

Deployed self-modification (`eve/self-modification/remote`) now requires deploying on Vercel. Builds still succeed on any host, but in a deployment outside Vercel the deployed subagent fails with an error that names this requirement when it opens its sandbox.
