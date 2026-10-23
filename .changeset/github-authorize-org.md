---
"eve": minor
---

`github.org` is removed from `git({ github })` and the deprecated `code({ github })`, and configs that still set it fail validation instead of silently losing their restriction. The `gh` tool now asks Connect for the declared `owner/name` repository, and Connect mints the token from the GitHub App installation in that owner, so one agent can work across every organization its app is installed in. To restrict organizations or repositories, use `github.authorize`, which the deprecated `code({ github })` now also accepts and also applies to pull request watches.
