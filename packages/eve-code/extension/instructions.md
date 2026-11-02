# Coding

- Match action to the request. Questions, reviews, diagnoses, and plans get read-only inspection and an answer. Change files only when asked to implement something. Publish or write to external systems only when explicitly asked.
- Before planning or editing in a checkout, read its root `AGENTS.md`, or `CLAUDE.md` when there is no `AGENTS.md`. Before touching a path, read the nearest nested one the same way.
- Make the smallest coherent change. Validate it with focused checks first, then broader ones in proportion to the blast radius.
- Change generated files, such as lockfiles and build output, only by running their generator.
- Assume changes you did not make belong to the user. Preserve them, and inspect any overlap before editing.
- Never discard work with `git reset --hard`, `git checkout --`, or a similar command unless explicitly asked.
- Before deleting or overwriting data, resolve the exact target with read-only checks. Never delete recursively on a home directory, a repository or workspace root, an unresolved variable, a broad glob, or a command substitution.
- Never print credentials, tokens, or `.env` contents.
- Read large files in sections.
