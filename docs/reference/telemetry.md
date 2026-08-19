---
title: "CLI telemetry"
description: "Understand eve CLI telemetry, its controls, and the data collected today."
---

# CLI telemetry

eve collects CLI telemetry by default to improve the command-line interface. Telemetry is optional: you can disable it for this machine or for one command.

## Data collected today

Each CLI invocation sends these fields to Vercel:

- eve version, operating system, CPU architecture, and whether stdin is a TTY;
- an allowlisted command path and outcome (`success`, `usage_error`, or `error`);
- for `eve dev`, whether the target is local or remote and whether the UI is headless or interactive;
- a random session identifier generated for that CLI invocation;
- a random installation identifier; and
- a salted one-way project identifier.

To derive the project identifier, eve uses the local Git `remote.origin.url`, `REPOSITORY_URL`, or the working directory, in that order. eve hashes that value with a random salt stored only on your machine. The raw project identifier and salt are not sent.

Telemetry does not include command arguments, agent files, prompts, URLs, request headers, error messages, arbitrary error properties, environment variables, file paths, or file contents. Raw environment values and file paths can be local inputs to the salted project identifier, but are not sent.

## Control telemetry

Disable telemetry for this machine:

```bash
eve telemetry disable
```

Check its current state or enable it again:

```bash
eve telemetry status
eve telemetry enable
```

Set `EVE_TELEMETRY_DISABLED=1` to disable telemetry for one command without changing the saved setting:

```bash
EVE_TELEMETRY_DISABLED=1 eve dev
```

Set `EVE_TELEMETRY_DEBUG=1` to print the collected event batch to stderr instead of sending it:

```bash
EVE_TELEMETRY_DEBUG=1 eve info
```

## Notice and local preference

On an interactive terminal, eve displays the telemetry notice and opt-out instructions once before collecting telemetry. The notice is versioned so eve can show an updated disclosure when the collected data changes materially.

The saved preference, installation identifier, and project salt are stored in the platform user configuration directory. In CI and Docker environments, eve uses a fresh in-memory installation identifier and project salt for each invocation instead of writing persistent identity state:

| Platform        | Path                                                              |
| --------------- | ----------------------------------------------------------------- |
| Windows         | `%APPDATA%\\eve\\config.json`                                     |
| macOS           | `~/Library/Preferences/eve/config.json`                           |
| Other platforms | `$XDG_CONFIG_HOME/eve/config.json` or `~/.config/eve/config.json` |

Vercel handles CLI telemetry under the [Vercel Privacy Notice](https://vercel.com/legal/privacy-notice).
