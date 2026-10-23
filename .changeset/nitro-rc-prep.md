---
"eve": patch
---

eve now builds on the upcoming Nitro v3 RC (currently `nitro-nightly`) and ships its own `rolldown`, so `eve build` and `eve dev` never install a bundler into your app. If your own routes use `nitro/storage`, add `unstorage` to your app's dependencies: Nitro no longer ships it and would otherwise install it during the build, and those routes now also bundle your app's `assets/` directory.
