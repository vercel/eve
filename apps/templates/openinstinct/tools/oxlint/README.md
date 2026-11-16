# Repository-owned Oxlint rules

The `next` plugin is a local adaptation of the Next.js architecture rules from
the Merit Systems Foundation repository at commit
`712131d17f4089097c4636e0dc924be1a108cb96`.

It is kept local because this public repository cannot depend on Foundation's
internal packages. The adaptation supports both root-level `app/` and
`src/app/` Next.js projects. Rule activation belongs in the root
`.oxlintrc.jsonc`.

The `architecture` plugin enforces the repository's production dependency
direction across `agent`, `app`, `db`, `shared`, and `web`. Root `proxy.ts` is
treated as web-owned. Violations are reported on static imports and exports,
dynamic imports, and Vitest or Jest module mocks.

The `anti-slop` plugin vendors the generic rules and shared helpers from
[`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop) at commit
`0b863049ca2173b74ae6ebf1f8d0f6f911f9a220`. The upstream Effect integration
is intentionally excluded. Its MIT license is included in the plugin folder.
The RuleTester cases under `anti-slop/tests` adapt the upstream suite at the
same commit and add local coverage for upstream gaps. Refresh those cases
whenever the vendored source is updated.
