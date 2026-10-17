# Public export lists

Each JSON file lists the named exports of one typed public `eve` package entry.
The TypeScript checker follows aliases and star re-exports from current source;
no declaration build is needed. The lists include experimental entries but do
not make them stable. `eve/internal/*` is excluded.

Check the lists with:

```sh
node scripts/public-exports.mjs
```

`pnpm guard:invariants` also checks them under rule 55. When an intentional API
change adds or removes names, update the lists in the same review:

```sh
node scripts/public-exports.mjs --write
```

These are name inventories, not structural compatibility reports. A type's
fields remain contractual even when its name is not exported. Authoring
capability compatibility is checked separately by the extension contract guard.
