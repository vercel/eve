---
"eve": patch
---

Upgrade Nitro to 3.0.261103-rc, the first Nitro 3 release candidate eve builds on.

eve now declares Rolldown 1.2.16 itself and hands that copy to Nitro, so a plain npm install builds without relying on another package to provide Rolldown, and Nitro never installs a package into your app on demand. Importing `nitro/storage`, `nitro/kv`, or `nitro/database` from agent code now fails the build with an explanation instead of pulling in storage drivers. A request with a method its path doesn't declare, other than `HEAD`, now gets `405 Method Not Allowed` with an `Allow` header instead of `404`. `eve dev` runs on env-runner 0.3, and a stopped `eve start` server runs Nitro's close hooks and exits on its own.

Thanks @pi0 for the investigation in #5167.
