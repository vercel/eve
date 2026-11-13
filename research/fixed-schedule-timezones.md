---
issue: "Not filed; prototype from schedule timezone feedback"
status: prototype
last_updated: "2026-11-12"
---

# Fixed schedule timezones

Add optional `timezone` to `defineSchedule` and Markdown schedule frontmatter:

```ts
import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "0 13 * * *",
  timezone: "America/Los_Angeles",
  content: "Send the daily digest.",
});
```

## Contract

- Interpret the cron expression in the named IANA timezone, including seasonal offset changes.
- Validate the timezone at compilation and preserve it in compiled artifacts and agent inspection.
- Preserve existing behavior when omitted: UTC on Vercel, process timezone in Nitro's self-hosted runner.
- Support both prompt and handler schedules, including Markdown and extension-mounted schedules.
- Manual development dispatch invokes the schedule immediately, regardless of its timezone.
- Support explicit timezones on Vercel and the Node server. Reject other Nitro presets rather than silently using UTC.

## Prototype boundary

Nitro 3.0.261103-rc registers tasks and dispatches them, but its `scheduledTasks` mapping has no timezone option.

On Vercel, keep Nitro's schedule registration and private function. Supply explicit `vercel.config.schedules` entries for timezone schedules; Nitro merges these over its generated entries. Use the route table's existing task names, including Vercel service prefixes.

On Node, register the same tasks but exclude explicit-timezone schedules from Nitro's automatic cron mapping. An eve runtime plugin uses vendored Croner 11 to invoke `runTask`. The plugin waits for host readiness and stops timers on shutdown. Other schedules keep Nitro's existing runner. No Nitro internals or generated modules are patched.

The Node runner follows Croner 11's transition semantics: fixed daily times in a spring gap run at the next valid local time; repeated times run at the first occurrence. Vercel retains its platform semantics. Exact cross-host DST transition parity is not promised by this prototype.

## Follow-up before release

- Confirm the desired cross-host policy for nonexistent and repeated local times with the Vercel Schedules owners.
- Consider upstream Nitro support so eve can remove its clock adapter without changing the authoring API.
- The prototype does not add retries, catch-up after process downtime, cross-process deduplication, or scheduled-occurrence metadata to handlers.
