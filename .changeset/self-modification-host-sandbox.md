---
"eve": minor
---

Run local self-modification directly in the project directory with `HostSandbox` and eve's default `edit_file` tool instead of a custom `just-bash` mountable filesystem, mounted in `eve dev` under `self` with subagent `modify` (`self__modify`).

Local self-modification now requires a POSIX host (Linux, macOS, or WSL2 on Windows) and renames the subagent from `agent` to `modify` (`self__modify` for the default local mount, `self-modification-remote__modify` for the default remote mount). Existing authored `agent/extensions/self-modification/` mounts remain supported without duplicating the bundled `self` mount.
