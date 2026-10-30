---
"eve": patch
---

Background work a channel route registers with `waitUntil` while its streamed response is still being sent now runs to completion on hosted platforms, instead of being dropped.

Channel route `params` keep encoded path separators (`%2F` and `%5C`) encoded, so a param can no longer contain a `/` or `\` that the request path never had. Other percent-encoded characters are still decoded, so `/files/caf%C3%A9` gives `café`; a handler that expected `%2F` decoded to `/` must now decode it itself.

Agent text that mentions a Nitro build constant such as `import.meta.dev` now reaches production builds unchanged, instead of being rewritten to its value or failing the build. Skill files are embedded in the server bundle instead of Nitro server assets, so hosted output no longer ships Nitro's storage layer.

A channel path that declares both `GET()` and `WS()` now accepts WebSocket upgrades, which the `GET` route used to answer as a plain HTTP request. WebSocket routes register for `GET` only, the method an upgrade uses. Because one handler serves both, the two routes must name their path parameters the same way; `eve build` rejects a pair such as `GET("/rooms/:id")` and `WS("/rooms/:room")`.

Vercel service builds keep the schedule consumer function and its queue trigger, so dynamic schedules deliver their occurrences.

`eve start` now runs the server's shutdown hooks, such as flushing instrumentation, when it stops the server in an environment that sets `CI`. The built server no longer inherits `CI` or `NITRO_UNIX_SOCKET` from `eve start`.

A server without eve's workflow program runtime installed now fails a generated workflow program with an error that explains why, instead of importing the runtime from a path hosted output can't resolve.
