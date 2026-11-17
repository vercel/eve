# eve Vercel Drives Starter

[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack) [![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

An [eve](https://eve.dev/) agent that reads and saves your team's files on a Vercel Drive. Each session gets a read-only snapshot of the Drive to search with shell commands, and the agent can save new notes and documents back to it. Talk to it in Slack or in your terminal.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-vercel-drives-starter&project-name=eve-vercel-drives-starter&repository-name=eve-vercel-drives-starter&connect=%5B%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%5D)

## Getting started

Vercel's project setup flow creates a repository in your Git account and a Vercel project. You'll create and install a Slack app via Vercel Connect, and no environment variables will need to be manually defined.

The upload script and the agent's `save_to_drive` tool create the Drive the first time they write to it. Sessions can't mount a Drive that has never been written to, so `/drive` is missing until you upload files or the agent saves one. Once you've deployed the agent, [upload some files](#adding-files), add the agent to a Slack channel, and @mention it to start your first conversation.

## Tech stack

| Layer             | Technology     |
| ----------------- | -------------- |
| Agent framework   | eve            |
| File storage      | Vercel Drives  |
| Agent workspace   | Vercel Sandbox |
| Slack integration | Vercel Connect |

## How it works

A session is one Slack thread, or one chat started with `pnpm dev`. When a session first uses its sandbox, the sandbox mounts a read-only snapshot of the Drive at `/drive`. The agent explores the files with shell commands such as `ls`, `find`, and `grep`, and reads them with `read_file`. The sandbox has no network access, and the template turns off eve's `web_fetch` and `web_search` tools so the agent can't send file contents to outside URLs.

To save a file, the `save_to_drive` tool runs in the app rather than the sandbox. It starts a short-lived sandbox that mounts the Drive read-write, writes the file, and stops. Only one sandbox can mount a Drive read-write at a time, so when another save or upload holds the read-write mount, the tool reports `drive_busy` and the agent offers to retry. A snapshot reflects the Drive as it was when it was mounted, so a saved file appears in new sessions and might not appear in the session that saved it.

The Drive helpers live in [agent/lib/drive.ts](agent/lib/drive.ts), and the session mount in [agent/sandbox.ts](agent/sandbox.ts).

## Adding files

Upload a local folder with the upload script. It needs Vercel credentials, so run the [local development](#local-development) setup first:

```sh
pnpm drive:upload content
```

This uploads the sample files in [content/](content/). Use `--prefix` to upload into a subfolder of the Drive:

```sh
pnpm drive:upload ~/team-docs --prefix docs
```

Existing files at the same paths are overwritten. See [Add your own files](CUSTOMIZATION.md#add-your-own-files) for which files the script skips. You can also ask the agent to save files: "Save a summary of this thread to notes/standup.md".

## Local development

Use Node.js 24 with pnpm for local development. Install the [Vercel CLI](https://vercel.com/docs/cli), then clone your repository and run:

```sh
pnpm install
vercel link
vercel env pull .env.local
pnpm drive:upload content
pnpm dev
```

When `vercel link` prompts you, choose your deployed project. `vercel env pull` downloads that project's environment variables to `.env.local`, including the token the agent uses to start Vercel Sandboxes and mount your Drive. This means local chats read and save files on the same Drive as your deployed agent. The token expires after 12 hours, so if a command later fails with an OIDC credentials error, run `vercel env pull .env.local` again.

`pnpm drive:upload content` copies the sample files in [content/](content/) to the Drive and creates the Drive if it doesn't exist yet. The agent can only mount a Drive that has files on it, so upload something before your first chat. To start with your own files instead, pass their folder, as described in [Adding files](#adding-files).

`pnpm dev` opens eve's interactive chat in your terminal. Try "What's in my Drive?" or "Summarize the onboarding checklist".

Before deploying, check your changes and confirm the agent builds:

```sh
pnpm validate
pnpm build
```

Use `pnpm fix` to apply automatic formatting and lint fixes. When the checks pass, deploy with:

```sh
vercel deploy --prod
```

## Customization

| Customize | Where |
| --- | --- |
| The agent's identity and behavior | [agent/instructions.md](agent/instructions.md) |
| Which Drive the agent uses | `DRIVE_NAME` and `DRIVE_REGION`, see [environment variables](CUSTOMIZATION.md#change-environment-variables) |
| Approval before saving | [Require approval before saving](CUSTOMIZATION.md#require-approval-before-saving) |
| New write tools and scheduled syncs | [Add a delete tool](CUSTOMIZATION.md#add-a-delete-tool) and [Sync files on a schedule](CUSTOMIZATION.md#sync-files-on-a-schedule) |
| Slack profile lookups | `SLACK_IDENTITY_EXCLUDED_USER_IDS`, see [Slack identity lookups](CUSTOMIZATION.md#control-slack-identity-lookups) |
| Model and session limits | [agent/agent.ts](agent/agent.ts) |

For more information on customizing the agent, see [CUSTOMIZATION.md](CUSTOMIZATION.md).
