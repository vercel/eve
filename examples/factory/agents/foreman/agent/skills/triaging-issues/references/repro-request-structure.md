# Repro Request Structure

The shape of a comment asking a reporter for reproduction details, with examples. Load when drafting one of these comments.

## The shape

Four parts, in order, rarely more than six or seven sentences total:

1. Acknowledge the specific report. One sentence proving you read it, not "thanks for opening this issue" alone.
2. Say what's missing and why it blocks progress. One sentence.
3. Ask for the smallest actionable set, as a list. Version, minimal steps or repro, expected versus actual. Add environment only when it plausibly matters (OS, browser, runtime).
4. Say what happens next once the details arrive.

## What to ask for

- The exact version they're running, not "latest".
- The smallest set of steps that shows the problem, or a link to a minimal repro repository or sandbox.
- What they expected to happen and what actually happened, verbatim errors included.
- Whether it worked on an earlier version, if the report smells like a regression.

Ask specific yes-or-no or either-or questions where you can. "Does this still happen with caching disabled?" moves the issue; "can you share more context?" doesn't.

## What to avoid

- A checklist longer than the reporter's original issue.
- Asking for things the report already contains. Re-read before asking.
- Template language that ignores their specifics. If the comment would fit any issue in the tracker, rewrite it.
- Blame or doubt ("works fine for me", "are you sure you configured it right"). Assume the report is honest and incomplete.

## Example: bug report with no version or steps

> Thanks, a hang on the second save and not the first is a useful detail. I can't reproduce it yet from what's here, so a few specifics would help:
>
> - which version of the CLI you're on (`app --version`)
> - the exact commands from a fresh start to the hang
> - whether it also hangs with `--no-cache`
>
> With those I can try to reproduce and get this to the right person.

## Example: crash with a stack trace but no repro

> That stack trace points at the config loader, which narrows it down. To pin it:
>
> - your `config.yml`, trimmed to whatever still triggers the crash
> - the runtime version (`node --version`)
> - whether this started after an upgrade, and from which version if so
>
> If you can get it down to a config of a few lines that still crashes, that's usually enough to fix it same-day.
