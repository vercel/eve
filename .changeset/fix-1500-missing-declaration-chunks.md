---
"eve": patch
---

Fix missing content-hashed declaration chunks in the published `eve` tarball. The chat and twilio vendor configs previously only co-copied `jsx-runtime-<hash>.d.ts` (chat) or no hashed chunks at all (twilio), so the upstream `messages-<hash>.d.ts` and `types-<hash>.d.ts` files were dropped from the published package — degrading ~120 chat exports to `any` and producing TS2307 errors with `skipLibCheck: false`. Extend `discoverExtraFiles` in `_shared.mjs` to fold the hashed siblings into the same declaration-rewrite pass as the named entry files, and add the chunk patterns (`messages-`, `types-`) to the chat and twilio configs. Also fixes a small set of `chat` and `@chat-adapter/twilio` type-surface leaks in eve sources and tests that were silently relying on the previous `any` fallback. Resolves #1500.
