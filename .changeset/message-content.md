---
"eve": minor
---

What a person sends is now eve's own `MessageContent`, exported from `eve/client` and `eve/channels`: a string, or text and file parts. Every send, `deliver` result, and schedule takes it instead of the AI SDK's `UserContent`. Text and file part literals pass unchanged; send an image as a file part with an `image/*` media type, and use `MessageFilePart` where you typed the AI SDK's `FilePart`. Chat SDK's `messageToUserContent` is now `messageContentOf`.
