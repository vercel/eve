---
"eve": patch
---

`bunx eve` and `bun run` scripts now run the eve CLI, dev server, and built server in Bun instead of falling back to Node.

The `eve` binary keeps its Node shebang but hands off to the Bun binary that launched it. `eve dev` now works in Bun, including WebSocket channels, and `eve build` in Bun emits Nitro's Bun server output with the same self-hosted deployment ID as Node builds.

Thanks @haydenbleasel for reporting the Bun dev server failure in #101.
