---
"eve": patch
---

`bunx eve` and `bun run` scripts now run the eve CLI, dev server, and built server in Bun instead of falling back to Node.

The `eve` binary keeps its Node shebang but replaces itself with the Bun binary that launched it. `eve dev` now works in Bun, including WebSocket channels.

`eve build` launched by Bun now writes Nitro's Bun server output, which must run in Bun; `eve start` in Node rejects it. Set `NITRO_PRESET=node-server` to keep Node output from a Bun script. Vercel builds stay in Node unless `vercel.json` sets `bunVersion`, so deployed functions keep the Node runtime.

Thanks @haydenbleasel for reporting the Bun dev server failure in #101.
