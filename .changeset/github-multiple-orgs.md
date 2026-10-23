---
"eve": patch
---

`github.org` in `git({ github })` and the deprecated `code({ github })` now also accepts an array of organizations. The `gh` tool and pull request watches mint each token from whichever listed organization owns the declared repository, so one agent can work across several GitHub organizations with the same connector.
