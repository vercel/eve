### Summary

<!--
Keep this short. Start with the concrete problem, user need, or decision that
prompted the change, then explain the solution and meaningful behavior or
decisions—not changed files or commits. Link an existing issue or discussion
when one exists (for example, "Closes #123" or "Related to #123"). Do not
create an issue solely to accompany this pull request. Call out breaking
changes, preserved behavior, scope boundaries, or stacked PRs when relevant.
-->

### Validation

<!--
In PR bodies, do **not** list routine checks like typecheck, lint, or standard test runs as "Test plan" items (those are implied engineering hygiene).
This also applies to reviewer-facing suggestions such as "recommended before merge: run `turbo typecheck test`" or "run `pnpm oxfmt-check` on the edited files" — CI already runs these on every PR, so listing them is noise. Only call out a check in Validation if it exercises change-specific behavior that CI does **not** cover (e.g. a manual production probe, a dashboard spot-check, a one-off data query).
Use the validation section only for change-specific verification: key scenarios exercised, expected behavioral outcomes, risk checks, and any manual/production-safe validation steps.
-->

### Checklist

- [ ] I added tests and documentation where relevant
- [ ] I added a changeset if this touches the published `eve` package
- [ ] DCO sign-off passes for every commit (`git commit --signoff`)
