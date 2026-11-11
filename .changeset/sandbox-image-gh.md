---
"eve": patch
---

Include the GitHub CLI (`gh`) in the sandbox base image, so a project's first `eve build` no longer installs it with `apt-get`.

Agents that call `installCodeTooling` from `eve/extensions/code/sandbox` skip the install when `gh` is already present, which removes about 7 seconds from the sandbox step of a first build and its dependency on Ubuntu's package mirror.
