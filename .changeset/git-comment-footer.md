---
"eve": minor
---

The `eve/extensions/git` `gh` tool can end comments, reviews, and review replies with an attribution footer.

Return `commentFooter` from `github.attribution` to set it. With a footer set, a command that would post a comment the footer cannot be added to is refused, and the error names the REST form to use. Body flags are now read front to back, so a body that starts with a dash is no longer read as a flag.
