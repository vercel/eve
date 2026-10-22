---
"eve": minor
---

The just-bash sandbox provider now runs on the public `defineSandboxProvider()` API, and `customCommands` and `filesystem` use eve-owned types from `eve/sandbox/just-bash`, such as `JustBashCommand` and `JustBashFilesystem`, that still accept just-bash's `defineCommand()` results and filesystems. Local just-bash templates rebuild once after upgrading, since their keys no longer include custom commands or the filesystem; reading a directory now rejects instead of returning `null`, and a command ending in a `# comment` runs in any working directory.
