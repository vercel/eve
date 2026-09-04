---
title: "CLI Telemetry"
description: "Learn what eve CLI telemetry collects and how to control it."
---

# CLI telemetry

eve collects usage data from its CLI to help improve its commands and development experience. You can turn telemetry off at any time.

## What eve collects

eve sends the following information to Vercel:

- The eve version, operating system, CPU architecture, and whether stdin is a terminal.
- The command you ran, its outcome, and setup or onboarding steps when applicable.
- For `eve dev`, whether you connected to a local or remote agent and whether the UI was interactive or headless.
- Random identifiers for the CLI session, installation, and project, plus whether the installation and project identifiers are ephemeral or persistent.

The project identifier lets eve group usage from the same project without sending its name or location. eve derives it from the Git remote when available, otherwise `REPOSITORY_URL` or the working directory, and transforms that value before sending it.

## What eve does not collect

eve does not collect command arguments, prompts, agent files, URLs, request headers, error messages, environment variables, file paths, or file contents.

## View telemetry data

Set `EVE_TELEMETRY_DEBUG=1` to print the telemetry batch to stderr instead of sending it:

```bash
EVE_TELEMETRY_DEBUG=1 eve info
```

## Turn telemetry off

Disable telemetry for this machine:

```bash
eve telemetry disable
```

Check its status or turn it back on:

```bash
eve telemetry status
eve telemetry enable
```

To disable telemetry for one command without changing the saved setting, set `EVE_TELEMETRY_DISABLED=1`:

```bash
EVE_TELEMETRY_DISABLED=1 eve dev
```

On an interactive terminal, eve displays this information once before it collects telemetry. eve saves your preference in your platform user configuration directory. In CI and Docker environments, eve uses fresh in-memory identifiers for each invocation instead of saving them.

Vercel handles CLI telemetry under the [Vercel Privacy Notice](https://vercel.com/legal/privacy-notice).
