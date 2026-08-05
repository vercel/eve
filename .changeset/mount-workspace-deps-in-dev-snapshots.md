---
"eve": patch
---

Dev runtime snapshots now mount workspace dependency packages in place
instead of copying them. Only roots that host runtime-hydrated authored
source — the app root, extension mount roots, and tsconfig path-alias
targets — are still copied, matching how installed dependencies already
resolved. In monorepos this removes the largest per-generation copy: a
workspace-linked framework package (hundreds of files and tens of
megabytes per rebuild) no longer lands under
`.eve/dev-runtime/snapshots/`.
