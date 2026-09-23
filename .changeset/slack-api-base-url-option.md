---
"eve": patch
---

`slackChannel` and `callSlackApi` accept an `api` option, `{ apiBaseUrl?, fileBaseUrl?, fetch? }`, that sends Slack Web API calls and attachment downloads to another host. `fileBaseUrl` defaults to `apiBaseUrl`, `fetch` is called only for URLs on those hosts, each base must be an absolute http or https URL with no query string or fragment, and omitting `api` keeps `https://slack.com/api/` and the global `fetch`.
