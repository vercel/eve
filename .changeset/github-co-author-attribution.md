---
"eve": minor
---

Add `github.attribution(ctx)` to `eve/extensions/git` and the deprecated `code({ github })` config. When it returns a `{ name, email }` co-author, the `gh` tool ends every `gh-signed-commit` message and `gh pr create` body with that person's `Co-authored-by` trailer.
