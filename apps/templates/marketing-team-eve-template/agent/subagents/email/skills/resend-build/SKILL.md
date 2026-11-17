---
description: Use when building, editing, or sending anything in Resend, including broadcasts, templates, segments, and contacts, or when checking what a past send did.
---

# Building in Resend

The tools are discoverable but the order matters, and several of them fail in ways that are quiet rather than loud. Read this before the first call, not after a call goes wrong.

Resend's tools are not preloaded. Find them with `eve__search` (the query `resend__` lists only Resend's), then call one with `eve__tool` by its qualified name (`resend__<tool>`). Don't guess at a tool name or its arguments.

## The build order

For a broadcast, which is one email to a segment:

1. `list-domains` and pick a verified one for the from address.
2. `list-segments` and pick the target. A broadcast requires a segment: there is no send-to-everyone option. If nothing covers the intended audience, say so and agree a segment with the user before creating one.
3. `create-broadcast` with the name, segment, subject, and the plain text version. This does not send.
4. `get-tiptap-json-content` with `include_schema: true`, then `compose-broadcast` to set the body.
5. Show the user what you built: subject, preview text, from, segment and its size, and the send time.
6. `send-broadcast`, which pauses for approval.

For a template, which is a reusable email with variables:

1. `create-template`. It is created as a draft.
2. `get-tiptap-json-content` with `include_schema: true`, then `compose-template`.
3. `publish-template`. A template cannot be used for sending until it is published, and re-publishing is how an edit goes live.

## The traps

**Always read before you compose.** Call `get-tiptap-json-content` before `compose-broadcast` or `compose-template`, even when you are certain the body is empty. Someone may have edited it in the dashboard, and composing without reading overwrites their work.

**Two content modes, and switching loses work.** Content set with `compose-*` is editable in the Resend visual editor; content set with `update-broadcast`'s `html` and `text` fields is not. Moving between the two modes is lossy. Prefer `compose-*` so the user can refine it themselves, and if raw HTML is genuinely wanted, ask before switching an existing body over.

**`update-broadcast` needs fields you have to fetch.** The API requires `from` and `segmentId` to be set, and a broadcast created in the dashboard may have neither. Call `get-broadcast` first and include them in the update if they are missing, or the call fails on something unrelated to what you were changing.

**Personalization needs fallbacks.** Placeholders use triple braces: `{{{FIRST_NAME}}}`, `{{{LAST_NAME}}}`, `{{{EMAIL}}}`, and `{{{RESEND_UNSUBSCRIBE_URL}}}`. `FIRST_NAME` and `LAST_NAME` take a fallback with a pipe, as in `{{{FIRST_NAME|there}}}`. Use it every time. Without one, contacts with no first name get "Hi ,".

**Include the unsubscribe URL.** `{{{RESEND_UNSUBSCRIBE_URL}}}` is how a visible unsubscribe link gets into the body, and marketing mail needs one. See the `deliverability` skill for why this is a hard requirement rather than a courtesy.

**Ids come in several forms.** Most tools accept a UUID, and many also accept a template alias or a Resend dashboard URL. Pass whatever the user gave you rather than trying to convert it.

## Sending and the approval gate

Sending a broadcast, an email, or a batch pauses for the user's approval, and so do deletes and changes to a contact's topic subscriptions. This is deliberate. Do not try to route around a gate by using a different tool to achieve the same effect.

- Say what the approval covers before you ask: the segment, the number of contacts, and the timing. That sentence is what the user is agreeing to.
- Never test by sending to a real segment. Send a one-off with `send-email` to an address the user names, or have them preview it in the dashboard.
- `send-broadcast` takes an optional `scheduledAt`. A scheduled send can be cancelled and an immediate one cannot, so when the user is hesitating, schedule it and tell them when the decision closes.
- `cancel-email` cancels a scheduled one-off. There is a window, not an unlimited one.
- If approval is denied, stop. Ask what to change rather than reissuing the call.

## Reading what happened

`get-email` and `list-emails` carry delivery outcomes for one-off sends, `get-broadcast` carries a broadcast's state, and `list-logs` and `get-log` carry the API request and response when something failed at the call level rather than at the delivery level.

Report the numbers you read, over the volume you read them across. Do not convert a delivery count into a claim about inbox placement: `deliverability` covers what those numbers do and do not prove.
