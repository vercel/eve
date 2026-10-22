---
"eve": minor
---

Remove the microsandbox sandbox provider. The `eve/sandbox/microsandbox` export and the `microsandbox` option on `DefaultSandbox.environment()` are gone, and `DefaultSandbox` now selects Vercel Sandbox on Vercel, then Docker when a daemon is reachable, then just-bash. To migrate, switch `MicrosandboxSandbox.image()` and `MicrosandboxSandbox.dockerfile()` to `DockerSandbox.image()` and `DockerSandbox.dockerfile()` from `eve/sandbox/docker`, and remove the `microsandbox` dependency.

Deployed self-modification (`eve/self-modification/remote`) now requires Vercel Sandbox. Builds still succeed on any host, but outside Vercel the deployed subagent fails with an error that names this requirement when it opens its sandbox.
