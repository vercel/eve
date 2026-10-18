---
issue: TBD
status: implemented
last_updated: "2026-10-18"
---

# Turn context from `onMessage`

Applications that check client-supplied state on the server have no way to show the checked version to the model for one turn. Request `clientContext` lasts one turn but comes only from the client. `onMessage` `context` comes from the server but stays in session history, so per-turn state piles up across turns. Applications work around this by sending the same state twice: once in a header the channel reads, once as `clientContext` the model reads. The model then sees the unchecked copy.

|                      | One turn, not stored          | Kept in history |
| -------------------- | ----------------------------- | --------------- |
| Client (`send`)      | `clientContext`               | —               |
| Server (`onMessage`) | `clientContext` (this change) | `context`       |

## Authoring API

```ts
eveChannel({
  auth,
  onMessage(ctx) {
    ctx.eve.clientContext; // the request's clientContext as sent, or undefined
    return { auth: defaultEveAuth(ctx), clientContext: ["The user's plan is pro."] };
  },
});
```

- `ctx.eve.clientContext` holds the request's `clientContext` exactly as sent.
- Client and server use one shape, `ClientContextValue` (a string, an array of strings, or a JSON object), exported from `eve/channels/eve`. eve turns either into model messages the same way.
- A returned `clientContext` replaces the request's for that turn, with the same lifetime: every model call in the turn, never session history.
- Omitting it keeps the request's context. `[]` drops it.
- eve labels client-supplied entries `Client context:`; returned context is sent without the label, so the model can tell server context from client claims.
- `onMessage` runs only for requests with a message. Input-response requests keep their own context, as today.

## Boundaries

The change stays in the eve HTTP channel. It resolves the turn's context before dispatch and attaches it through the existing client-context path, so the harness, storage, and custom channels are unchanged. Request parsing now keeps the validated value; turning it into labeled model messages moves to dispatch, so `onMessage` sees the value as sent.
