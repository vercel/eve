---
"eve": patch
---

`slackChannel` accepts an `api` option, `{ apiBaseUrl?, fileBaseUrl?, fetch? }`, that points its Slack Web API calls and attachment downloads at another host, matching the option `discordChannel`, `telegramChannel` and `githubChannel` expose. The bases say where a call may go, and `api.fetch` says how that traffic travels: it is confined to the configured bases' origins, so a wrapper can attach credentials for the host without checking each destination itself. `slackChannel()` checks each base at construction and throws on one that is not an absolute http or https URL, naming the option. Omitting `api` keeps `https://slack.com/api/` and the global `fetch`.
