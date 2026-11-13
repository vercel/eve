---
"eve": minor
---

Add optional IANA timezones to fixed schedules so jobs can keep a local time across daylight saving changes.

Set `timezone` in `defineSchedule` or Markdown frontmatter on Vercel and self-hosted Node servers. Omitting it preserves the host's existing behavior. Other Nitro presets reject explicit timezones.
