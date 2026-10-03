---
issue: https://github.com/vercel/eve/issues/4304
status: proposed
last_updated: "2026-10-03"
---

# A reason a custom channel's `fetchFile` can give the model

When a custom channel's `fetchFile` throws, the model sees only "Attachment
retrieval failed in the "<kind>" channel." (#2090), so nothing a resolver
throws (URLs, tokens, upstream text) reaches it. Built-in channels pass a safe
reason ("Telegram file rejected — …") through `EveAttachmentError`, which is
internal. A custom channel that refuses a file for a reason the person can act
on, such as a body larger than the provider declared, cannot say so.

Export one helper from `eve/channels`, and keep the class internal:

```ts
import { attachmentError } from "eve/channels";

fetchFile: async (url) => {
  const bytes = await download(url);
  if (bytes === "too_large") throw attachmentError("The file is over 100 MB.");
  return { bytes };
};
```

`attachmentError(message, { cause? })` returns an error whose `message` becomes
the model-visible note, exactly as built-in channels' messages do today.
`kind` stays `"resolver-threw"` and is not part of the authoring API. The
channel does not set `adapterKind`: `tryFetchFile` fills it from the channel
that ran the resolver when the error carries none, so operator logs name the
real channel. Any other thrown value keeps today's generic note.

eve cannot check what a message says, so the rule is documented where the
helper is: the message carries safe details only, with no URLs, credentials or
verbatim upstream text, and private diagnostics go on `cause`, which stays in
operator logs. `docs/channels/custom.mdx` replaces "Custom channel errors use a
generic note" with that rule and an example. Built-in channels may move to the
helper; their notes do not change.

Tests: a unit test for the helper's shape; an integration staging test where a
custom channel's `attachmentError` message reaches the model note and the logged
`adapterKind` is the channel's, and where a plain `Error` still yields the
generic note.
