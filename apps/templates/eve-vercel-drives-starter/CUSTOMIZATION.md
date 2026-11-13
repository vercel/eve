# Customize your Vercel Drives eve agent

Adapt the template's files, write tools, and Slack behavior through environment variables and files under `agent/`.

Choose the task you want to complete:

- [Change environment variables](#change-environment-variables)
- [Change instructions and model settings](#change-instructions-and-model-settings)
- [Add your own files](#add-your-own-files)
- [Require approval before saving](#require-approval-before-saving)
- [Add a delete tool](#add-a-delete-tool)
- [Sync files on a schedule](#sync-files-on-a-schedule)
- [Mount a second Drive](#mount-a-second-drive)
- [Control Slack identity lookups](#control-slack-identity-lookups)
- [Remove Slack](#remove-slack)
- [Test and deploy your changes](#test-and-deploy-your-changes)
- [Set up an existing project](#set-up-an-existing-project)

## Change environment variables

Environment variables choose the Drive the agent uses and configure Slack. For local development, add them to `.env.local` in the project folder. For the deployed agent, add each one to your Vercel project with `vercel env add` followed by its name:

```sh
vercel env add DRIVE_NAME
```

Enter the value when prompted, and choose the Vercel environments that should use it. To replace an existing value, add `--force`.

| Vercel environment | Where the value applies                                |
| ------------------ | ------------------------------------------------------ |
| **Production**     | The live agent                                         |
| **Development**    | Local development through `vercel env pull .env.local` |
| **Preview**        | Preview deployments                                    |

After changing variables on Vercel, run `vercel env pull .env.local` to download them for local use. Restart `pnpm dev` or deploy again with `vercel deploy --prod` to apply the changes. The examples below use `.env.local` syntax; when the CLI asks for a value, enter only the part after `=`.

[.env.example](.env.example) lists every variable the template reads:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DRIVE_NAME` | `eve-drive` | The Drive that sessions mount and that `save_to_drive` and `pnpm drive:upload` write to |
| `DRIVE_REGION` | `iad1` | The region of the Drive and of every sandbox that mounts it |
| `SLACK_CONNECTOR` | Set by the template setup | The Vercel Connect connector for Slack, such as `slack/drive-agent` |
| `SLACK_IDENTITY_EXCLUDED_USER_IDS` | Empty | Slack user IDs to skip in [identity lookups](#control-slack-identity-lookups) |

The upload script and `save_to_drive` create the Drive named by `DRIVE_NAME` in `DRIVE_REGION` the first time they write to it. Sessions can mount the Drive only after something has been written to it, so a new Drive leaves `/drive` missing until your first upload or save. Changing `DRIVE_NAME` points the agent at a different Drive, and files on the previous Drive stay there. A Drive's region can't change after it's created, and a sandbox can mount a Drive only in its own region. To move to another region, set `DRIVE_REGION` together with a new `DRIVE_NAME` and upload your files again.

The upload script reads `.env.local`, so run `vercel env pull .env.local` after changing either Drive variable on Vercel. Otherwise local uploads go to the old Drive.

## Change instructions and model settings

### Identity and tone

Edit [agent/instructions.md](agent/instructions.md) to describe who the agent works with and how it should respond. Describing how your files are organized helps the agent search the right folder first. For example:

```md
The Drive holds the platform team's documentation. Runbooks are in `/drive/runbooks`, architecture decisions are in `/drive/adr`, and meeting notes are in `/drive/notes`, named by date. When someone asks how to handle an incident, check the runbooks before anything else.
```

Keep the existing sections on reading and saving files alongside your own guidance. They tell the agent that `/drive` is a snapshot, how to choose a path when saving, and how to respond when a save reports that the Drive is busy.

### Model and token limits

Change `model` in [agent/agent.ts](agent/agent.ts) to use another [AI Gateway model](https://vercel.com/ai-gateway/models). The template uses `openai/gpt-6.1-sol-fast` and authenticates with Vercel OIDC. For other hosting environments, see [AI Gateway authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok).

The same file limits each session to `300_000` input tokens through `maxInputTokensPerSession`. Each model call counts the input it sends, including earlier messages and the file contents the agent has read, so reading many large files reaches the limit sooner. When a session crosses the limit, eve pauses it and asks whether to continue. Increase the limit if sessions pause too often. See [eve's agent configuration](https://eve.dev/docs/agent-config) for output and cost limits.

## Add your own files

Replace the sample files in [content/](content/) or upload any local folder. Run the script from the repository directory after `vercel env pull .env.local`:

```sh
pnpm drive:upload ~/team-docs
```

The script uploads every file under the folder, keeping its relative path, and prints each Drive path it wrote. To place the files in a subfolder of the Drive, add `--prefix` with a relative path:

```sh
pnpm drive:upload ~/team-docs --prefix docs
```

With this prefix, `~/team-docs/runbooks/deploy.md` becomes `/drive/docs/runbooks/deploy.md`. A few rules decide what gets uploaded:

- Files whose path contains a segment starting with `.`, such as `.git/config` or `.env`, are skipped.
- Symlinks are skipped, and the script prints how many it skipped.
- Files at the same Drive path are overwritten. Files on the Drive that aren't in the folder stay there.
- Files are copied byte for byte, so binary files such as images and PDFs upload intact. The agent reads files with shell commands and `read_file`, so text formats such as Markdown, CSV, and JSON are the most useful to it.

The upload holds the Drive's read-write mount for its duration. If the agent is saving a file at the same time, the script exits with a message that the Drive is in use; run it again when the save finishes. A session reads the snapshot mounted when it first used its sandbox, so start a new session, such as a new Slack thread, to see the uploaded files.

Drives are in public beta and are billed for storage, reads, and writes. A new Drive's maximum size defaults to 1 TiB, or 1 GiB on Hobby. See [Sandbox pricing](https://vercel.com/docs/sandbox/pricing#drive-storage) for rates and Hobby allotments, and the [Drives documentation](https://vercel.com/docs/sandbox/concepts/drives) for limits.

## Require approval before saving

`save_to_drive` runs without approval by default, so the agent saves as soon as someone asks. To pause each save until a person confirms it, add an `approval` policy to [agent/tools/save_to_drive.ts](agent/tools/save_to_drive.ts):

```ts
import { once } from "eve/tools/approval";

export default defineTool({
  approval: once(),
  // description, execute, and inputSchema stay the same
});
```

`once()` asks for approval the first time the tool runs in a session and allows later calls in that session automatically. Use `always()` to require approval for every save. eve's channels, including Slack, render the approval prompt for you. In Slack, anyone in the thread can answer the prompt, including the person who asked, so approval confirms intent rather than restricting who can save. To limit who can approve, add an `onInputResponse` check to the Slack channel, as described in [eve's Slack guide](https://eve.dev/docs/channels/slack). See [eve's human-in-the-loop guide](https://eve.dev/docs/human-in-the-loop) for the other policies, including `auto()`, which asks a decision model whether a call needs a person.

## Add a delete tool

`withWritableDrive` in [agent/lib/drive.ts](agent/lib/drive.ts) mounts the Drive read-write in a short-lived sandbox and gives your callback a workspace with `writeFiles` and `remove`. New write tools can reuse it. Create `agent/tools/delete_from_drive.ts`:

```ts
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  DriveBusyError,
  resolveDrivePath,
  withWritableDrive,
} from "../lib/drive";

/**
 * Deletes a file from the Vercel Drive after a person approves the call.
 */
export default defineTool({
  approval: always(),
  description:
    "Delete a file from the shared Vercel Drive. The file disappears from new sessions; this session's /drive snapshot keeps it. " +
    "Returns deleted: false with reason drive_busy when another write is in progress.",
  async execute({ path }) {
    const absolute = resolveDrivePath(path);
    try {
      await withWritableDrive(async (workspace) => {
        await workspace.remove([absolute]);
      });
    } catch (error) {
      if (error instanceof DriveBusyError) {
        return { deleted: false as const, reason: "drive_busy" as const };
      }
      throw error;
    }
    return { deleted: true as const, path: absolute };
  },
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe('Path relative to the Drive root, such as "notes/old.md".'),
  }),
});
```

The filename becomes the tool name the model sees. `resolveDrivePath` rejects absolute paths and `..` segments, so the tool can't reach outside the Drive, and `always()` asks a person before each deletion because it can't be undone. `remove` runs `rm -f`, so deleting a path that doesn't exist still returns `deleted: true`, and an invalid path throws instead of returning a result the model can act on. Mirror the `invalid_path` handling in [save_to_drive.ts](agent/tools/save_to_drive.ts) if your agent needs it. Add a sentence to [agent/instructions.md](agent/instructions.md) saying when the agent should offer to delete a file.

Only one sandbox can mount a Drive read-write at a time. `withWritableDrive` throws `DriveBusyError` when another sandbox holds the read-write mount, so return that to the model as a result, as above, and let it tell the person to retry.

## Sync files on a schedule

To keep the Drive in step with another source, add a schedule that downloads the files and writes them with `withWritableDrive`. Schedules run in your app, so they can reach the network and use credentials from environment variables, while session sandboxes stay without network access. Create `agent/schedules/sync-handbook.ts`:

```ts
import { defineSchedule } from "eve/schedules";

import {
  DriveBusyError,
  resolveDrivePath,
  withWritableDrive,
} from "../lib/drive";

/** Source documents to copy, keyed by their path on the Drive. */
const SOURCES = {
  "handbook/onboarding.md":
    "https://raw.githubusercontent.com/your-org/handbook/main/onboarding.md",
} satisfies Record<string, string>;

/** Downloads every source document, then writes them in one Drive session. */
const syncHandbook = async () => {
  try {
    const files = await Promise.all(
      Object.entries(SOURCES).map(async ([path, url]) => {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Fetching ${url} failed with ${response.status}.`);
        }
        return { content: await response.text(), path: resolveDrivePath(path) };
      })
    );
    await withWritableDrive(async (workspace) => {
      await workspace.writeFiles(files);
    });
  } catch (error) {
    if (error instanceof DriveBusyError) {
      console.info("drive.sync_skipped", { reason: "drive-in-use" });
      return;
    }
    console.error("drive.sync_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Copies the team handbook to the Drive every day at 06:00 UTC.
 */
export default defineSchedule({
  cron: "0 6 * * *",
  run({ waitUntil }) {
    waitUntil(syncHandbook());
  },
});
```

Replace the entries in `SOURCES` with your own Drive paths and URLs. The handler downloads every file before mounting the Drive, so a failed download leaves the Drive unchanged and holds the read-write mount only while writing. If a save or upload holds the read-write mount when the schedule runs, it logs `drive.sync_skipped` and the next run tries again.

On Vercel, each schedule becomes a Vercel Cron Job and the expression is evaluated in UTC. `pnpm dev` doesn't run schedules on their cadence. To run this one once while the dev server is running, send:

```sh
curl -X POST http://localhost:2000/eve/v1/dev/schedules/sync-handbook
```

See [eve's schedules guide](https://eve.dev/docs/schedules) for prompt-based schedules and for sending results to a channel.

## Mount a second Drive

A sandbox can mount up to four Drives, each at its own path. For example, keep a reference Drive that people update through the upload script but the agent never writes to. Sessions can mount a Drive only after something has been written to it, so upload files to the new Drive first. Setting `DRIVE_NAME` for one command makes the script create and write to that Drive in `DRIVE_REGION`:

```sh
DRIVE_NAME=reference-docs pnpm drive:upload ~/reference
```

Variables set on the command line take precedence over `.env.local`. Then replace [agent/sandbox.ts](agent/sandbox.ts) with:

```ts
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

import { DRIVE_NAME, DRIVE_PATH, DRIVE_REGION } from "./lib/drive";

/**
 * Sandbox environment for the agent: always Vercel Sandbox, in the Drives' region.
 */
export const environment = VercelSandbox.environment({ region: DRIVE_REGION });

/**
 * Opens the session sandbox with read-only snapshots of the team Drive and the reference Drive.
 *
 * @returns The opened Vercel sandbox, falling back to an unmounted sandbox when a Drive can't be mounted.
 */
export default defineSandbox(async () => {
  try {
    return await environment.open({
      mounts: {
        [DRIVE_PATH]: { drive: DRIVE_NAME, mode: "snapshot" },
        "/reference": { drive: "reference-docs", mode: "snapshot" },
      },
      networkPolicy: "deny-all",
    });
  } catch (error) {
    console.warn("drive.unavailable", {
      message: error instanceof Error ? error.message : String(error),
    });
    return await environment.open({ networkPolicy: "deny-all" });
  }
});
```

Both Drives must be in `DRIVE_REGION`, and a Drive's region can't change after it's created. If either Drive is missing or has never been written to, the agent logs `drive.unavailable` and opens a sandbox with neither mount, so check the logs if `/drive` goes missing after this change. Tell the agent about `/reference` in [agent/instructions.md](agent/instructions.md), including that it can't save there.

## Control Slack identity lookups

Before responding to a Slack mention or direct message, the agent looks up the Slack profiles of the sender, anyone mentioned, and the people who posted in the thread since its last reply, then adds their names and profile images to the conversation as context. This uses the `users:read` permission. The agent never adds email addresses, so it can't reveal them to other people in a channel.

To skip profile lookups for selected bot or service accounts, set:

```dotenv
SLACK_IDENTITY_EXCLUDED_USER_IDS=U0123456789,U0987654321
```

Excluded users can still interact with the agent; this setting only skips their profile lookups. The lookup code and its tests are in [identity.ts](agent/lib/integrations/slack/identity.ts) and [identity.test.ts](agent/lib/integrations/slack/identity.test.ts).

## Remove Slack

To use the agent only through eve's HTTP channel, which `pnpm dev` uses, delete the Slack files:

```sh
rm agent/channels/slack.ts agent/lib/testing/slack.ts agent/lib/utils/env.ts agent/lib/values.ts
rm -r agent/lib/integrations
pnpm remove @vercel/connect
```

`env.ts` and `values.ts` are used only by the Slack integration. Then update the remaining Slack references:

- In [agent/instructions.md](agent/instructions.md), the identity and the examples that mention Slack threads.
- In [README.md](README.md), the `connect` parameter in the Deploy button URL, the Slack row in the tech stack table, and the Slack row in the customization table.
- In your Vercel project, the `SLACK_CONNECTOR` and `SLACK_IDENTITY_EXCLUDED_USER_IDS` variables.

Run `pnpm validate` afterward; `knip` reports any file or dependency that's no longer used.

## Test and deploy your changes

Run the project checks before deploying:

```sh
pnpm validate
pnpm build
```

Save any environment variable changes with the [CLI commands above](#change-environment-variables), then deploy:

```sh
vercel deploy --prod
```

The automated tests replace the Vercel Sandbox and Drive APIs with fakes, so they confirm path handling and the busy check but not access to your Drive. After deploying, start a new Slack thread and ask what's on the Drive. Ask the agent to save a short note, then start another thread and confirm the note appears. Slack events reach only your production deployment unless you set up a separate preview connector as described in [eve's guide to testing a preview branch](https://eve.dev/docs/channels/slack#test-a-preview-branch).

## Set up an existing project

Use these steps if you have a Vercel project but haven't connected Slack through the [template setup](README.md#getting-started). With the [Vercel CLI](https://vercel.com/docs/cli) installed, open a terminal in your agent's repository directory and run:

```sh
vercel link
```

Select your existing Vercel project when prompted. This tells subsequent CLI commands which project to configure.

### Connect Slack

Create a connector and register the agent's Slack route:

```sh
vercel connect create slack --name drive-agent \
  --triggers --trigger-path /eve/v1/slack
vercel connect attach slack/drive-agent
```

Follow the browser prompts to connect the agent to your Slack workspace. If you choose another name, use it in the attach command and `SLACK_CONNECTOR` below. Events go to the production deployment at `/eve/v1/slack`. See [eve's Slack guide](https://eve.dev/docs/channels/slack) for event subscriptions and troubleshooting.

### Configure and deploy

Add the Slack connector name:

```sh
vercel env add SLACK_CONNECTOR
```

Enter `slack/drive-agent`, matching the connector created above, and select all environments. If the variable already exists, repeat the command with `--force` to replace its value.

Download the environment variables, upload your files so sessions have a Drive to mount, and deploy:

```sh
vercel env pull .env.local
pnpm drive:upload content
vercel deploy --prod
```

The upload creates the Drive if it doesn't exist. Invite the agent to a Slack channel and ask what's on the Drive. For local testing, use `pnpm dev` after downloading the environment variables.
