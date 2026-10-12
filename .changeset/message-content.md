---
"eve": minor
---

What a person sends is eve's own type, `MessageContent`: a string, or `MessagePart`s (text and
file parts), exported from `eve/client` and `eve/channels`. Every send, `deliver` result, and
schedule takes it instead of the AI SDK's `UserContent`.

- It is the subset eve accepted already, so text and file part literals pass unchanged. A file
  part's `data` is the file inline (bytes, base64, or a `data:` URL) or a URL.
- Image parts are gone: send a file part with an `image/*` media type. A value typed as the AI
  SDK's `FilePart` needs eve's `MessageFilePart` instead, since the AI SDK's allows tagged data and
  provider references eve doesn't take.
- Chat SDK's `messageToUserContent` is `messageContentOf`.
