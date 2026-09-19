---
"eve": patch
---

The Slack channel accepts `api: { url, fetch }` to point every outbound Slack Web API call at a different base — a local simulator, a proxy, or a fixture server — falling back to `SLACK_API_URL` and then to `https://slack.com/api/`. `callSlackApi` takes the same override per call as `apiUrl` / `fetch`, and inbound `url_private` downloads accept files hosted on the configured origin alongside Slack's own file hosts.
