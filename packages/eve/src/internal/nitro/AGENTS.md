# Nitro host foundation invariants

eve's Nitro host is built from one typed host spec, one ordered plugin list, and one route table.
Review and `pnpm guard:invariants` enforce these rules:

1. **Nitro is configured from data.** One adapter turns a typed host spec into the `NitroConfig`
   passed to `createNitro`. Nothing writes `nitro.options` afterward. The only hooks eve uses are
   declared in that config: the `build:before` entry wrapper and `build:config` edits that public
   options can't express. No `rollup:before`.
2. **Development and production differ by data, not code paths.** One spec function covers both.
3. **One ordered, filtered plugin list per build.**
   - Every eve build plugin uses hook `filter`s, except where it truly needs every id.
   - Authored-source builds share one plugin factory.
   - Nothing patches a third-party plugin or rewrites Nitro's generated modules.
4. **Generated code carries data through `text:` or `bytes:` imports,** never as inlined JS
   literals, so Nitro's `replace` can't touch it.
5. **Every eve-owned Nitro id uses `#eve/`.** No `#nitro/` ids, no ad hoc prefixes. Route and task
   virtual module ids end in `.mjs`, because the bundler infers module type from the id's
   extension and an id can embed an authored route path (#5742).
6. **eve never lets Nitro resolve or install a dependency.** Rolldown comes through `deps.paths`.
   Storage and database runtimes are rejected in authored code.
7. **Post-build output rewriting is a named, shrinking list.** Each entry is tied to an upstream
   ask, and new entries need justification.
8. **Development host builds are one-shot.** eve configures no watchers, watch options, or reload
   hooks on Nitro.
9. **Tests protect behavior.** No test pins private Nitro ids or hook names, or calls Nitro hooks
   by hand. Production code has no seams that exist only for tests.
