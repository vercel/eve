# Stagehand extension template

This package demonstrates a native eve extension that imports the published
Stagehand v4 SDK directly. It does not copy Stagehand source or require a
wrapper command.

The extension declares `@browserbasehq/stagehand` in
`eve.extension.externalDependencies` because Stagehand loads its browser
extension from package-relative assets at runtime. eve preserves the complete
Stagehand package automatically when a consuming agent is built.

Build the extension locally:

```bash
pnpm --filter @eve-template/stagehand-extension build
```

Set `BROWSERBASE_API_KEY` and optionally `BROWSERBASE_PROJECT_ID` to use a
Browserbase session. Without those variables, the extension launches a local
browser. `STAGEHAND_BROWSER` can explicitly select `local` or `browserbase`.
