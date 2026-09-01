---
"@eve/self-modification": patch
"eve": patch
---

The self-modification subagent can now install items from the configured eve
registry. A new `selfmod__registry_add` tool runs `eve add <address>
--non-interactive --skip-setup` in the application root under `eve dev`,
pausing the authored-source watcher for the whole install and reporting the
item's declared environment variables that are still unset. Failed dependency
installs restore tracked project files and return a sanitized, structured reason
instead of implying the project was untouched. Items that declare a setup flow
or multiple components are never partially installed: they are reported back
untouched with the command that finishes them, so no setup question is ever
answered by the model.
