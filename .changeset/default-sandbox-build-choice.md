---
"eve": minor
---

`DefaultSandbox` now selects its provider once, when eve prepares the sandbox, and records the choice in the build: Vercel Sandbox on Vercel, then Docker when a daemon is reachable, then just-bash only in `eve dev` and `eve eval`. The runtime uses the recorded provider instead of probing the host again, so a build and its server can no longer select different providers. A production `eve build` with neither Vercel nor Docker no longer falls back to just-bash: the build succeeds, and opening the sandbox fails with an error that asks you to start Docker and rebuild, deploy to Vercel, or select a provider explicitly.

`DefaultSandbox.environment().open()` now accepts `networkPolicy`, and its sessions expose `setNetworkPolicy()`. eve forwards the policy to the selected provider, and just-bash rejects any policy other than `"allow-all"`. Sessions saved by an earlier eve under the provider that `DefaultSandbox` selected resume the same sandbox.

`VercelSandbox.environment()` no longer captures a snapshot when the environment has no `prepare` callback, no managed workspace or skill files, and no `source`. Session sandboxes start from the image and install the base runtime themselves, as `DefaultSandbox` already did on Vercel.

Custom providers' `onSessionEnd()` now also receives the current build's prepared artifact as `options.artifact`.
