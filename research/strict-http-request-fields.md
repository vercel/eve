---
issue: "None (maintainer proposal; related PR #4930)"
status: in-progress
last_updated: "2026-10-21"
---

# Reject unknown HTTP request fields

## Decision

Before 1.0, reject unrecognized top-level fields in framework-owned HTTP JSON
request bodies with **400 Bad Request**. Name the unknown field and list the
accepted fields for the matched route. This PR implements the breaking change for
session creation, follow-up messages and answers, and session controls.

Before this change, session parsers selected recognized fields and ignored remaining
keys, with a few explicit exceptions. A typo such as `outputschema`, an option from a
newer client, or a field sent to the wrong route could succeed without its intended
effect. The response gave people and agents no indication of how to correct the
request.

## Request contract

Each route has an explicit set of accepted top-level fields. Check every supplied
key against that set; field names are case-sensitive. Do not strip unknown keys,
correct their spelling, or accept the union of fields from unrelated routes.

An illustrative message-route response is:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{
  "ok": false,
  "error": "Unknown field 'outputschema'. Accepted fields: message, answers, clientContext, outputSchema, turnPolicy, callback, forwardedPrincipal."
}
```

The accepted-field list must describe the actual route and supported protocol,
including any recognized protocol-specific fields. The combined pre-1.0 cleanup
uses `answers` for follow-up responses.

For multiple unknown fields, identify them in a deterministic order and include
the accepted-field list. Report field names, not request values. Diagnostics show
at most eight names, shorten names longer than 128 characters with an ellipsis,
and flag omitted names.
A fieldless control route rejects any supplied top-level field; an empty object
or absent body remains valid where already supported.

Preserve authentication and authorization checks. Reject invalid fields before
admitting work, calling authored message handlers, or dispatching a control. A
400 must not create a session, enqueue a delivery, or partially apply a command.
Do not replace an authentication failure with request-field diagnostics.
Authored authentication hooks, such as `trustedForwarders` resolving a forwarded
principal, belong to the authentication step and may run before field
validation.

Known fields still require their existing type, value, and combination checks.
For example, recognizing `outputSchema` does not make every value valid or allow
it on a route where it has no defined effect.

## Scope and compatibility

Apply this rule to eve-owned JSON request envelopes, starting with session
creation, follow-up messages and answers, and session control routes. These routes
now keep accepted fields beside their parsers and reuse the same list for
validation and diagnostics. Other HTTP protocol surfaces keep their existing
validation in this PR, including callback/webhook protocols and the legacy
`/eve/v1/task-input/:token` capability route where that protocol is served.

This proposal does not recursively close arbitrary JSON values. Declared open
objects such as `clientContext` and application data retain their contracts.
It does not impose a universal schema on authored routes, third-party webhook
payloads, HTTP headers, query parameters, or non-JSON transports.

Supported protocol fields must be explicitly recognized. The legacy
`activityObserver` field remains a recognized no-op only on delegated requests
with a `callback`. Known remote protocol fields, forwarded principals, and tool
stubs retain their existing validation and permission checks. None of these
contracts permits arbitrary unknown fields.

A delegated create request on an unsupported remote protocol retains the structured
409 protocol-mismatch response before request-field diagnostics. After successful
protocol negotiation, a newer client that sends a new field to an older strict
server receives a 400 instead of silently losing the requested behavior. This is the intended lasting
compatibility rule. A future `operationId` on follow-up messages must not be
silently discarded: doing so could change retry or deduplication semantics.
Clients must not automatically remove behavior-changing fields and retry.

For purely advisory hints, define an explicit way to ignore unsupported hints
safely when that need exists. The envelope must already be recognized by the
older server, or its use must be negotiated. Adding another unknown top-level
field cannot bypass strict validation. No generic hints container or permissive
compatibility switch is proposed here.

## Implementation and validation boundary

The session parsers in
[`request.ts`](../packages/eve/src/eve-channel/request.ts) reject unknown fields
before dispatch and preserve existing field-value validation. The
[route tests](../packages/eve/src/public/channels/eve-session-routes.test.ts) cover
typos and wrong-route fields without admission or message-handler side effects,
bounded diagnostics, authentication ordering, and open payloads. The
[create-request tests](../packages/eve/src/eve-channel/request.test.ts) retain the
explicit legacy activity-observer contract.

The fixture-owned HTTP eval covers rejecting a typo and a create-only field,
then accepting each corrected request. Run that eval in CI. Callback/webhook
protocols and query-parameter validation are outside this implementation.
