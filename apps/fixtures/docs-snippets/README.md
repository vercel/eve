# Docs snippets

Typechecked copies of the code blocks in selected docs pages. Each section's
snippets live at `<page path without extension>/<heading slug>/<block title>`,
beside any support files they import. A section that repeats another page's
snippets holds a `same-as.txt` naming that section's directory, so both pages
stay on one copy.

Edit the file here, then run `node scripts/check-doc-fixtures.mjs --write` from
the repository root to copy it into the page. `pnpm docs:check` fails when a
page and its fixture differ, and `pnpm typecheck` compiles every snippet.
`docs/quick-reference.md` is fully covered: every titled `ts` or `tsx` block on it needs
a fixture.
