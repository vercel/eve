---
"eve": minor
---

The just-bash sandbox provider now runs on the public `defineSandboxProvider()` API; running sessions and prepared templates keep working unchanged. `customCommands` and `filesystem` in `JustBashSandbox.environment()` now use eve-owned types, `JustBashCommand` and `JustBashFilesystem` from `eve/sandbox/just-bash`, instead of just-bash's `CustomCommand` and `IFileSystem`; just-bash's `defineCommand()` results and filesystems such as `MountableFs` are still accepted. Reading a directory from a just-bash sandbox, for example with `readTextFile()`, now rejects instead of returning `null`, as Docker already does.
