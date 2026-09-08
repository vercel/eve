---
issue: TBD
status: implemented
last_updated: "2026-09-07"
---

# Interactive channel sender auth

## Goal

Let a durable channel resolve an accepted message's sender into `SessionAuthContext` before model or tool execution, including a sign-in flow that can park and later resume the original input.

## Authoring API

Slack accepts `AuthFn<SlackEvent>` and the eve HTTP channel accepts `AuthFn<Request>`, each as one strategy or an array. The ordered walk has three non-error outcomes:

- `SessionAuthContext` accepts the sender.
- `null` or `undefined` falls through.
- `AuthInteractionRequired` (`{ interaction: "required", startAuthorization, completeAuthorization }`) claims the input and starts sign-in.

A message handler that returns its own `auth` property supplies a final override and bypasses the configured walk. Property presence is intentional: `{ auth: null }` bypasses, while `{}` uses the resolver.

## Lifecycle and boundaries

```text
accepted channel input
  -> route verification / message hook admission
  -> durable sender-auth walk
       -> authenticated: set current auth and continue
       -> interaction required: emit authorization.required, journal input, park
  -> callback: complete auth, set current auth, replay input
  -> dynamic capabilities, model, and tools
```

The framework core owns the durable gate, callback correlation, pending authorization state, and deferred input. Channel adapters own event typing and the configured auth walk. Sender sign-in reuses the existing authorization challenge, callback, protocol event, and private Slack rendering machinery; protocol events mark sender auth with `purpose: "session"`, while an absent purpose retains the existing connection-auth meaning.

Generic route auth remains separate and cannot park arbitrary HTTP work. `eveChannel` recognizes an interactive result only on create and follow-up message requests, retains the parsed message, and hands a scrubbed request descriptor to the shared durable gate. Its info, stream, control, forwarded-principal, delegated callback, operation-id, and input-response paths still require immediate route identity. Slack request-signature verification and handler admission also remain separate from sender identity resolution.

## Invariants

- An interactive result parks before dynamic capability or model setup.
- The original accepted input and JSON-serializable resume data survive the callback.
- Only `completeAuthorization` supplies the final session identity.
- The session initiator is set on first successful sender authentication and is not replaced on later turns.
- Sign-in challenges use the existing private-delivery channel surface and are never included in model-visible authorization signals.
- Exhausting the configured walk fails closed.

## Coverage

Unit coverage exercises ordered fallthrough, Slack and eve message admission, explicit handler overrides, credential scrubbing, interactive start/completion, durable parking before model creation, and callback replay with final current and initiator auth.
