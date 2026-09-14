# A2A extension consumer

This deterministic fixture mounts the private [`@eve/a2a` prototype](../../../packages/eve-a2a/README.md) through `agent/extensions/a2a.ts`. The extension provides `a2a__send`, `a2a__get`, `a2a__cancel`, and the A2A channel. The durable `a2a_delegate` watcher remains an application tool because the current extension compiler rejects workflow directives.

From the repository root:

```sh
pnpm --filter @eve/a2a... build
pnpm --filter fixture-a2a-public-api verify
```

For manual exploration, run `pnpm --filter fixture-a2a-public-api dev`. The server listens on `127.0.0.1:4317` with local demonstration credentials `alice:prototype-only` and `bob:other-prototype-only`. Its fixed signing key and credentials belong only to this fixture.

```sh
curl -u alice:prototype-only http://localhost:4317/a2a \
  -H 'content-type: application/json' \
  -H 'a2a-version: 1.0' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"demo-1","role":"ROLE_USER","parts":[{"text":"REMOTE ask"}]}}}'
```

This waits for `TASK_STATE_INPUT_REQUIRED`. Send another message with the returned task ID in `message.taskId` and the answer as a text part. Other deterministic inputs are `REMOTE hello` and `REMOTE wait 5`.

POST `{"message":"DELEGATE wait 5"}` to `/demo` with the same credentials to exercise `a2a_delegate` through the model. Read the resulting session events at `/demo/<returned-id>/events`.

`A2A_ORIGIN` controls the advertised origin and `A2A_REMOTE_ORIGIN` selects the remote agent; both default to `http://localhost:4317`. The fixture mount supplies local defaults for `A2A_DEMO_PASSWORD`, `A2A_OTHER_PASSWORD`, and `A2A_SIGNING_SECRET`. The extension itself requires explicit configuration.

`verify` copies the built extension distribution into a temporary consumer with fresh local state. It covers discovery, authentication, owner isolation, blocking and immediate sends, input replies, cancellation, SSE, namespaced tool dispatch, parent notifications, and recovery of a remote task and its watcher after server restart. It uses a deterministic model; it does not establish real-model tool selection or external A2A interoperability.
