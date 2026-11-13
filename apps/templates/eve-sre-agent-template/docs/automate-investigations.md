---
title: Automate investigations with generic webhooks
description: Start Slack investigations through an authenticated HTTP endpoint.
---

# Automate investigations with generic webhooks

Confirm that Slack replies work before you enable automation. The bot must already be a member of each target Slack channel.

## Set the shared secret

Create a long random secret before you store it. Use at least 32 bytes of entropy. Node 24 is already required for this project, so a portable generator is:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add `WEBHOOK_SECRET` to the production environment. Enter the generated value at the CLI prompt. Do not put the value in chat, source code, or logs. Any non-empty string works. Prefer a high-entropy random value so callers cannot guess it.

```bash
vercel env add WEBHOOK_SECRET production
pnpm exec eve deploy
```

Callers can send the secret in either header:

```text
x-sre-webhook-secret: <secret>
Authorization: Bearer <secret>
```

The `x-sre-webhook-secret` header takes priority when both headers are present.

## Start an investigation

Send `POST /v1/investigate`. A valid request returns `202 Accepted` and schedules a Slack investigation without a triage turn.

```bash
curl --request POST "https://<your-deployment-hostname>/v1/investigate" \
  --header "content-type: application/json" \
  --header "authorization: Bearer $WEBHOOK_SECRET" \
  --data '{
    "title": "Checkout error rate increased",
    "description": "HTTP 500 responses increased in production.",
    "slackChannel": "C0123456789",
    "metadata": {
      "service": "checkout-api",
      "environment": "production",
      "monitorId": "123456",
      "incidentId": "123456"
    }
  }'
```

| Field | Required | Purpose |
| --- | --- | --- |
| `title` | Yes | Investigation label shown in Slack. |
| `slackChannel` | Yes | Target Slack channel ID. |
| `description` | No | Summary of the issue to investigate. |
| `metadata` | No | Context from the caller, such as alert, incident, service, or time-window data. |

A `202 Accepted` response confirms authentication, body validation, and background scheduling. Confirm the investigation thread in Slack separately.

## Verify delivery

After receiving `202`:

1. Confirm that the target Slack channel receives an investigation card and thread.
2. If no thread appears, confirm that `slackChannel` is a channel ID and that the bot belongs to that channel.
3. Inspect Vercel runtime logs for `[sre/investigation] webhook session start failed` or `[sre/slack] failed to post investigation answer`.

## Check errors

The endpoint uses these status codes:

- `202` for an accepted request
- `400` for invalid JSON or an invalid body
- `401` for a missing or incorrect secret

If Deployment Protection applies to the endpoint, configure [Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation). Send its secret in the `x-vercel-protection-bypass` header in addition to `WEBHOOK_SECRET`.
