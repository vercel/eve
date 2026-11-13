# Customize your Contentful agent

Adapt the template to your Contentful content model and editorial workflow through environment variables and files under `agent/`.

Choose the task you want to complete:

- [Change environment variables](#where-to-change-environment-variables)
- [Connect your Contentful spaces and locale](#choose-your-contentful-spaces-and-locale)
- [Change writing style and model settings](#change-writing-style-and-model-settings)
- [Choose which content needs approval](#choose-which-content-needs-approval)
- [Recognize your website's URLs](#recognize-your-websites-urls)
- [Protect long RichText fields](#protect-long-richtext-fields)
- [Control Slack replies](#control-slack-replies)
- [Configure content search on Vercel Drives](#configure-content-search-on-vercel-drives)
- [Customize saved user preferences](#customize-saved-user-preferences)
- [Extend the agent](#extending-the-agent)
- [Add a team directory with Global Config](#add-a-team-directory-with-global-config)
- [Set up an existing project](#set-up-an-existing-project)

## Where to change environment variables

For local development, edit `.env.local`. To save a variable in your linked Vercel project, use `vercel env add` followed by its name. For example, to specify which Contentful spaces the agent can access:

```sh
vercel env add CONTENTFUL_SPACE_IDS
```

Enter the value when prompted and select all Vercel environments to use it throughout the project.

| Vercel environment | Where the value applies                                |
| ------------------ | ------------------------------------------------------ |
| **Production**     | The live agent                                         |
| **Development**    | Local development through `vercel env pull .env.local` |
| **Preview**        | Preview deployments                                    |

To replace an existing variable, append `--force` to the same command. The [Vercel environment variable commands](https://vercel.com/docs/cli/env) also support updating existing values with `vercel env update`.

After changing variables on Vercel, run `vercel env pull .env.local` to download them for local use. Restart `pnpm dev` or deploy again with `vercel deploy --prod` to apply the changes. The examples below use `.env.local` syntax; when the CLI asks for a value, enter only the part after `=`.

## Choose your Contentful spaces and locale

### Spaces

Set `CONTENTFUL_SPACE_IDS` to the IDs of the Contentful spaces the agent can access:

```dotenv
CONTENTFUL_SPACE_IDS=your-space-id,another-space-id
```

You can give those spaces names that are easier to use in conversation:

```dotenv
CONTENTFUL_SPACE_IDS={"website":"your-space-id","help":"another-space-id"}
```

Replace the example IDs with your own. The names `website` and `help` are aliases you can use when talking to the agent; space IDs work too. The token in `CONTENTFUL_MANAGEMENT_TOKEN` must have access to every space you include. The agent discovers content types and fields directly from Contentful.

### Environment and locale

`CONTENTFUL_ENVIRONMENT_ID` tells the agent which Contentful environment to read and edit within each space. Leave it unset to use `master`. If you have created another environment in Contentful, such as `staging`, you can point the agent there instead:

```dotenv
CONTENTFUL_ENVIRONMENT_ID=staging
```

The chosen Contentful environment must exist in every configured space.

`CONTENTFUL_LOCALE` selects the language version of translated fields that the agent reads and edits. Shared fields use the Contentful environment’s default locale. Leave it unset to use each Contentful environment's default locale. To use a specific locale, set its code, which must be available in every configured Contentful environment:

```dotenv
CONTENTFUL_LOCALE=en-GB
```

Field edits preserve values in other locales. Contentful publication makes all pending changes on an entry live, so publishing isn't limited to the locale used for the edit.

To check the configuration:

1. Ask the agent to list content types in one of your configured spaces. Use its space ID or alias, such as `website` in the example above.
2. Give the agent the ID of an existing entry in that space and ask it to read the entry.
3. Open the Contentful link in its response. Check that it points to the space and environment you configured, such as `staging` in the example above or `master` if you kept the default.

## Change writing style and model settings

### Identity and tone

Edit [agent/instructions.md](agent/instructions.md) to describe your audience and writing guidelines. For example:

```md
Write for developers evaluating our product. Use American English and sentence-case headings. Prefer concrete examples to promotional claims. Preserve product names and code identifiers exactly.
```

Keep the existing editing and publication guidance alongside your writing rules. It tells the agent to read entries before changing them and follow the approval process.

Use a skill for a procedure the agent only needs for certain tasks. The existing [SQL query skill](agent/skills/search_content/SKILL.md) and [structured query skill](agent/skills/contentful_api.ts) are examples. Put a task-specific writing checklist in a new skill instead of adding every editorial rule to the main instructions.

### Model and token limits

Change `model` in [agent/agent.ts](agent/agent.ts) to use another [AI Gateway model](https://vercel.com/ai-gateway/models). The template uses `anthropic/claude-opus-5.5-fast` and authenticates with Vercel OIDC. For other hosting environments, see [AI Gateway authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok).

The same file limits each session to `5_000_000` input tokens and `100_000` output tokens through `maxInputTokensPerSession` and `maxOutputTokensPerSession`. Increase the input limit if sessions stop after reading large amounts of content, or the output limit if they stop after generating long responses. See [eve's agent configuration](https://eve.dev/docs/agent-config) for the supported settings.

The [current-time instructions](agent/instructions/current-time.ts) add a UTC timestamp at the start of each turn. If you add regional date conventions, explain the intended timezone in your instructions so editorial dates remain unambiguous.

## Choose which content needs approval

Every content type requires publication approval by default. The code calls these entries "pages", even when your schema uses another name. You can exempt supporting content types, called "components", as described below.

| Action | Default behavior |
| --- | --- |
| Create a page | Save a draft |
| Update entry fields | Save without publishing |
| Publish one or more pages | Show one Slack approval card listing everything that will be published |
| Create an entry of an exempt component type | Create and publish it |
| Publish only exempt components | Run without an approval prompt |
| Upload new assets during creation or updates | Process and publish the assets |

### Exempt supporting components

Set `CONTENTFUL_COMPONENT_TYPES` to a JSON object mapping each space ID to a list of content type IDs. Use space IDs here, not aliases:

```dotenv
CONTENTFUL_COMPONENT_TYPES={"your-space-id":["author","callout","codeBlock"]}
```

Use the actual IDs from your schema. In this example, entries of these types can publish without approval. Other types continue to require approval. Content types with configured website routes are always treated as pages, even if you also list them as components.

Component exemptions affect shared content: publishing an author or callout can change every page that references it. Choose exemptions according to how your editors use those entries.

### What gets published with a page

Contentful pages can reference separate entries, such as an author profile, and assets such as images. When you ask the agent to publish a page, it checks those references and shows the content it will publish in the Slack approval card. Approving the card approves everything listed on it.

For example, suppose an article references an author profile, a new image, and a related article. If you have configured the author content type as an exempt component:

| Referenced content | What happens when you publish the article |
| --- | --- |
| Author profile with unpublished edits | Its edits are included in the approval card and published with the article |
| New image | It is included if it still needs publication and Contentful has finished processing it |
| Related article that is already published | It stays at its published version; any pending edits remain unpublished |

To publish edits to the related article too, ask the agent to publish both articles. If the related article has never been published, you must include it in the request before the agent can proceed. These rules concern Contentful references, not ordinary website hyperlinks in the text.

### Publish supporting components separately

When a publication request contains only components exempt from approval, the agent also publishes any unpublished components or processed assets they reference. It leaves pending edits to referenced content that's already live unpublished. To include edits to another supporting entry, ask the agent to publish that entry too.

For example, publishing an author profile can publish its new profile image too, but won't publish pending edits to an image that's already live. This behavior applies to all exempt component types. Content types with website routes still require page approval.

### Who can edit and approve

Any authenticated user who can interact with the agent can edit content and request publication. Approval is open to other authenticated users as well as the requester; the template has no designated approvers. The same users can cancel a publication request. Slack apps and Workflows that mention the agent can't edit content or answer publication requests, because both require a person's Slack identity.

To restrict editing or approval to designated people, follow the [team directory extension](#add-a-team-directory-with-global-config).

### Customize approval cards and handle failed operations

To change the approval card's wording or layout, edit [publication-message.ts](agent/lib/contentful/publication-message.ts). Keep the list of entries and assets visible so the approver knows what will be published. The button handling in [publication-input.ts](agent/lib/contentful/publication-input.ts) also checks that Slack received the card before accepting approval; preserve this check.

Before publishing, the agent checks whether the entries have changed since the request was prepared. Publication stops at the first failure, so inspect the reported results before retrying: some items may already be live. If an operation involving asset uploads returns a recovery ID, give that ID to the agent and ask it to resume the operation. The saved record lets it reuse uploads that already succeeded.

Changing Contentful configuration invalidates pending approval and recovery plans. Resolve in-progress requests before changing which content the agent can access or how it publishes.

## Recognize your website's URLs

The agent already recognizes Contentful entry links. To let it find entries from your website URLs too, set your website's base URL and specify which URL paths belong to each content type:

```dotenv
CONTENTFUL_PUBLIC_ORIGIN=https://www.example.com
CONTENTFUL_PAGE_ROUTES={"article":{"spaceId":"your-space-id","contentTypeId":"article","urls":[{"prefix":"articles"}]}}
```

With this configuration, `https://www.example.com/articles/getting-started` looks up an `article` entry whose `slug` field is `getting-started`.

| Setting | Meaning |
| --- | --- |
| `article` | Your name for this route |
| `spaceId` | The space ID, rather than its alias, included in `CONTENTFUL_SPACE_IDS` |
| `contentTypeId` | The content type's API ID |
| `prefix` | The path before the slug, without leading or trailing slashes |

Use lowercase prefixes. The agent looks up the final URL segment in the entry's `slug` field, converting it to lowercase first. Supported slugs contain only ASCII letters, digits, or hyphens and must start with a letter or digit. To support other paths, add routes or prefixes to a route's `urls` array; links generated by the agent use the first prefix.

Set `CONTENTFUL_PUBLIC_ORIGIN` to your website's HTTPS base URL, such as `https://www.example.com`, without a path. For multiple domains or a different slug field, adapt the URL helpers in [entries.ts](agent/lib/contentful/entries.ts) and [model.ts](agent/lib/contentful/model.ts), then add cases to [the URL tests](agent/lib/contentful/entries.test.ts).

## Protect long RichText fields

By default, the agent can replace an entire RichText field in one edit. To require changes to individual blocks, such as paragraphs in a long article, mark the field as protected:

```dotenv
CONTENTFUL_PROTECTED_FIELDS=["website/article/body"]
```

Each value uses `space/contentTypeId/fieldId`. The space can be an alias such as `website` or a raw ID. Replace `article` and `body` with the IDs in your schema.

Before changing a protected field, the agent reads its blocks and records a hash for each one. If a block changes before the edit is applied, the hash check rejects the edit. The agent can set protected fields when creating an entry, but later edits cannot replace or remove the whole field.

Try a paragraph edit on a test entry and confirm that neighboring blocks and other locales remain unchanged. The patch implementation and its tests are in [rich-text-patch.ts](agent/lib/contentful/rich-text-patch.ts) and [rich-text-patch.test.ts](agent/lib/contentful/rich-text-patch.test.ts).

## Control Slack replies

Mention the agent or send it a direct message to start a conversation. In a thread with no other participants besides you and the agent, you can send follow-up messages without mentioning it again. Slack must be configured to send those messages to the agent and let it read the thread; see [eve's Slack setup guide](https://eve.dev/docs/channels/slack).

To have the agent reply to new messages in selected channels without a mention, set:

```dotenv
SLACK_AUTO_REPLY_CHANNEL_IDS=C0123456789,C0987654321
```

Replace the examples with Slack channel IDs. Only new posts from people start a reply in these channels, and users in other channels can still mention the agent or send it a direct message.

To require mentions for thread follow-ups, add `autoReply: false` inside the existing `createSlackChannel` configuration in [agent/channels/slack.ts](agent/channels/slack.ts). Keep the `inputRequests` setting, which connects the custom publication card. Clear `SLACK_AUTO_REPLY_CHANNEL_IDS` as well to stop replies to new channel messages that don't mention the agent.

Other Slack apps and Workflows can start a conversation by mentioning the agent. Their turns run with the bot's Slack identity rather than a person's, so the agent can look up and draft content for them but won't change or publish entries or save writing preferences for a bot. When someone replies in the thread, the agent acts with that person's permissions.

If you pass your own `onMessage` handler to `createSlackChannel`, it also receives mentions and direct messages unless you set `onAppMention` or `onDirectMessage`.

The agent reads Slack profiles to identify people in conversations, using the `users:read` permission. It passes names and profile images to the model and never email addresses. To skip profile lookups for selected bot or service accounts, set:

```dotenv
SLACK_IDENTITY_EXCLUDED_USER_IDS=U0123456789,U0987654321
```

Excluded users can still interact with the agent; this setting only skips their profile lookups.

## Configure content search on Vercel Drives

The agent keeps a copy of your Contentful content on Vercel Drives and runs SQL over it, both to find the pages that cover a topic and to answer questions that cover many entries at once, such as counts or audits. Scheduled syncs keep this copy up to date. Before editing or publishing, the agent reads the entries directly from Contentful to check their latest values.

### Drive and region

The agent stores content from all configured Contentful spaces in one Drive. The first sync creates that Drive if it doesn't already exist.

Both environment variables below are optional. When they are unset, the code uses the following fallback values:

| Variable                       | Fallback when unset |
| ------------------------------ | ------------------- |
| `CONTENTFUL_MIRROR_DRIVE_NAME` | `contentful-mirror` |
| `CONTENTFUL_MIRROR_REGION`     | `iad1`              |

Set either variable to override its fallback. The region applies to the Drive and the sandboxes used to search and update it.

If you run two versions of the agent in the same Vercel project, one reading Contentful's `master` environment and another reading `staging`, use a separate Drive name for each. Syncing both to the same Drive can replace one version's searchable content with the other's. With a single version of the agent, you can keep the default Drive name.

Each conversation searches a fixed copy of the Drive taken when its sandbox starts. After a sync, start a new Slack thread to search the updated content. If the Drive is unavailable, the agent queries Contentful directly.

### Refresh schedule

The default schedule refreshes all content daily and removes deleted entries from the Drive. It runs at 16:30 UTC, though [Vercel Hobby](https://vercel.com/docs/cron-jobs/usage-and-pricing#hobby-scheduling-limits) can run it at any point within that hour. To change the time, edit `cron` in [contentful-mirror-nightly.ts](agent/schedules/contentful-mirror-nightly.ts).

For more frequent updates on Pro or Enterprise, create `agent/schedules/contentful-mirror-hourly.ts` with:

```ts
import { defineSchedule } from "eve/schedules";

import { runScheduledMirrorSync } from "../lib/contentful/mirror/drive";

export default defineSchedule({
  cron: "0 * * * *",
  run({ waitUntil }) {
    waitUntil(runScheduledMirrorSync("incremental"));
  },
});
```

This adds an hourly sync of entries changed since the last successful sync. Keep the daily full refresh to remove deleted entries, and redeploy to apply schedule changes. The hourly sync also performs a full refresh if no previous sync exists or the Contentful configuration has changed.

`pnpm dev` doesn't run these schedules automatically, and its terminal UI hides informational logs by default. To test a sync with all logs visible, run:

```sh
vercel env pull .env.local
pnpm dev --logs all
```

Open another terminal and run the following command, which updates the real Vercel Drive:

```sh
curl -X POST http://localhost:2000/eve/v1/dev/schedules/contentful-mirror-nightly
```

The command starts the sync in the background. In the terminal running `pnpm dev --logs all`, look for:

| Log message | Meaning |
| --- | --- |
| `contentful.mirror_sync` | Content was copied to the Drive and the sync record was saved |
| `contentful.mirror_sync_failed` | The run encountered an error; the log includes its message |
| `contentful.mirror_sync_skipped` | Another sandbox held the Drive's write access, so this run made no changes |
| `contentful.mirror_database_built` | The SQL database was rebuilt from the copied content; the log includes how long it took |
| `contentful.mirror_database_failed` | The SQL database could not be built; the log includes the error, and the copied content was still saved |

To read saved logs from an interactive local session, run `pnpm exec eve logs` in another terminal. These logs include informational messages even when the chat UI hides them.

Local chat uses `just-bash` and cannot search or query the Drive, even after a successful sync. To test the refreshed content, start a new conversation with the agent in Slack.

The copied entries are stored at `/contentful/<space-id>/<entry-id>.md`, each with a JSON record at the same path ending in `.json`. Content type definitions are stored in `/contentful/content-types.ndjson` and each space's members in `/contentful/users.ndjson`, outside the space folders so that searches never treat them as entries. The users file holds only each member's ID and name, which let SQL answer questions about who created or updated content. Listing members requires a Contentful token that can read the space's users; when it can't, the sync logs `contentful.mirror_users_failed` and keeps the previous file, or writes an empty one, so editor names stay unavailable until the token can read them. The file `/contentful/manifest.json` records when the last sync succeeded and names the SQL database when that sync built one. To change the indexed text or the fields available to SQL, edit [mirror/files.ts](agent/lib/contentful/mirror/files.ts) and update its rendering tests.

### Query the copy with SQL

Each sync writes a JSON record beside every entry's Markdown file. The record holds the entry's metadata, the IDs of the users who last created, updated, and published it, its plain field values such as strings and lists, and every entry and asset it links to, including those embedded in rich text. Each sync also saves the definition of every content type in your configured spaces to `/contentful/content-types.ndjson`, including each field's data type, whether it is required, and which content types its links may point to. After writing the files, the sync combines them into one DuckDB database at `/contentful/mirror.duckdb`, which the `search_content` skill reads with SQL. Because one query covers every configured space without pagination, the agent can answer counts and audits across all of your content in a single step instead of paging through the Contentful API, and the stored definitions let it check which fields a content type has or requires without a separate lookup. For edits made since the last sync, it still queries Contentful directly, and it always reads the live content type before creating or changing an entry.

The sync's sandbox has no network access, so the application downloads a pinned DuckDB release from GitHub, checks its SHA-256 checksum, and stores the binary on the Drive at `/contentful/.bin/duckdb`, where agent sessions run the same copy. Later syncs reuse the stored binary. To change the DuckDB version, update `DUCKDB_VERSION` and the checksums for both architectures in [mirror/database.ts](agent/lib/contentful/mirror/database.ts).

When the database can't be built, for example because the sandbox image lacks a library DuckDB needs, the sync still saves the updated files and omits the database from the manifest. The agent then runs the same SQL directly against the files and gets identical answers, though each query reads every file and can take a few seconds once the Drive holds tens of thousands of entries. The `contentful.mirror_database_failed` log message explains what went wrong.

To keep the first query in a conversation fast, the agent reads the database in the background when the conversation's sandbox starts. eve doesn't repeat that setup when it resumes a sandbox that had stopped, so in conversations that have already used SQL, the agent repeats the background read at the start of each turn. Conversations that never use SQL skip it. If the background read can't start, the agent logs `contentful.mirror_prefetch_failed` and queries normally.

The skill defines the tables `entries`, `refs`, `pages`, `content_types`, and `type_fields` and the full-text `search()` function with its `search_text` helper, which [mirror/database.ts](agent/lib/contentful/mirror/database.ts) builds. The skill keeps its own copy of these definitions in `agent/skills/search_content/scripts/views.sql` for when no database is available, and a test fails if the two copies differ, so update both together.

## Customize saved user preferences

Edit the `description` in [agent/memory/user-preferences.ts](agent/memory/user-preferences.ts) to change what the agent remembers about each user's writing preferences. For example, you might ask it to remember whether someone prefers brief summaries or detailed explanations.

The `byHumanPrincipal` scope in [scope.ts](agent/lib/memory/scope.ts) stores preferences separately for each authenticated person and turns them off for Slack apps and Workflows, so text a bot relays can't change what the agent remembers. These preferences are saved in the connected private Blob store, so switching to a new store means the agent no longer reads the previously saved preferences. Local development uses temporary memory.

See [eve's file-memory configuration](https://eve.dev/docs/memory/file) for storage options and limits on how much saved information the agent recalls.

## Extending the agent

### Add tools and skills

Choose the extension point that matches the change:

| You want to add | Where to put it |
| --- | --- |
| Editorial procedure or checklist | Markdown skill under `agent/skills/` |
| Action with validated inputs | Tool under `agent/tools/` |
| Shared implementation used by tools | Helper under `agent/lib/` |
| Context supplied on every turn | Dynamic instructions under `agent/instructions/` |

For example, create `agent/skills/product-copy.md` with a description that tells the model when to load it:

```md
---
description: Use when drafting or editing product-page copy.
---

Read the existing Contentful entry before editing and preserve its product names. Support feature claims with supplied sources. Save proposed edits without publishing.
```

Skills guide the agent through a task using its existing tools. To add an action it cannot perform yet, follow [eve's tool guide](https://eve.dev/docs/tools) and use the files in `agent/tools/` as examples. New tools that change Contentful content should call `requireContentfulEditor` from [access.ts](agent/lib/contentful/access.ts) and check that the entry has not changed since it was read. Use the existing publication workflow when a tool needs to publish pages.

### Add a team directory with Global Config

Use a team directory when the agent needs to recognize your editorial team or limit who can change and publish content. You can store membership in [Vercel Global Config](https://vercel.com/docs/global-config) and check each user against that directory. This extension requires code changes; the template currently allows any authenticated user to edit content and respond to publication requests.

#### 1. Connect a directory

Follow the [Global Config setup guide](https://vercel.com/docs/global-config/get-started) to create a store and connect it to your project. Install its SDK from the repository root:

```sh
pnpm add @vercel/global-config
```

The connection supplies a `GLOBAL_CONFIG` environment variable containing the store's read connection string. Run `vercel env pull .env.local` to download it for local development.

Add an item named `EDITORIAL` containing a `team` object. Each key in `team` is a member's Slack user ID; its value holds the details you want the agent to know about that person. For example:

```json
{
  "EDITORIAL": {
    "team": {
      "U0123456789": {
        "name": "Alex Example",
        "email": "alex@example.com"
      }
    }
  }
}
```

Replace the example with your members. `EDITORIAL` is a key you choose; names and emails provide context, while authenticated Slack IDs determine membership. For multiple Slack workspaces, include the workspace ID in your directory keys and match both identifiers.

#### 2. Resolve authenticated members

Create a shared helper such as `agent/lib/team.ts` that reads `EDITORIAL` with the SDK's `get` function and validates the result with Zod. Match the Slack user ID from `session.auth.current` for tool calls, or from `response.principal` for the person approving or cancelling a request. In both cases, require an identity authenticated by the Slack channel.

Allow restricted actions only after a successful lookup confirms membership. If the directory is unavailable or invalid, reject the action. Use authenticated IDs for these checks, since names supplied in messages or Slack profiles aren't proof of membership. Supporting another channel requires a corresponding way to match its authenticated users to the directory.

#### 3. Apply your access policy

Choose whether membership controls all Contentful writes or only publication approval, then update the corresponding checks:

| Policy point | Where to implement it |
| --- | --- |
| Who can write to Contentful | `requireContentfulEditor` in [access.ts](agent/lib/contentful/access.ts) |
| Who can request publication | `approval.request` in [publish_contentful_entry.ts](agent/tools/publish_contentful_entry.ts) |
| Who can approve or cancel a pending request | `approval.response` in [publish_contentful_entry.ts](agent/tools/publish_contentful_entry.ts) |

Check membership again when executing a write and when processing an approval response, because a user may have left the team since making the request. Preserve the existing checks for content versions and delivery of the approval card.

Restricting approval responses still allows users to publish exempt components and upload assets, which publish during entry creation or updates. To limit all Contentful writes to members, enforce membership in `requireContentfulEditor`. If non-members should be able to save drafts, add separate membership checks wherever components or assets publish as well as in the publication tool.

#### 4. Give the agent team context

Add dynamic instructions under `agent/instructions/` that look up the user's team membership at the start of each turn, using the `turn.started` event. You can also add a read-only tool under `agent/tools/` for finding teammates. Both should use the shared directory helper and expose only the fields needed for the task.

Team context helps the agent explain permissions, but the code checks above enforce them. Test the extension with a member and a non-member, then confirm that a failed directory lookup blocks restricted actions. Also remove a member while a publication request is pending: their approval response should be rejected without publishing or closing the request.

## Test and deploy your changes

Run the project checks before deploying:

```sh
pnpm validate
pnpm exec eve info
pnpm build
```

The automated tests don't call the live Contentful API, so also test your configuration against a non-production Contentful environment. Ask the agent to read an entry and save a draft edit, then request publication in Slack. Confirm that the approval card lists the intended content and that cancelling leaves it unpublished.

Save any environment variable changes with the [CLI commands above](#where-to-change-environment-variables), then deploy:

```sh
vercel deploy --prod
```

After deployment, start a new conversation and ask the agent to read an entry. Check its Contentful link to confirm the space and environment, then try a writing task that uses your updated instructions.

## Set up an existing project

Use these steps if you have a Vercel project but haven't connected Slack or Blob through the [template setup](README.md#getting-started). With the [Vercel CLI](https://vercel.com/docs/cli) installed, open a terminal in your agent's repository directory and run:

```sh
vercel link
```

Select your existing Vercel project when prompted. This tells subsequent CLI commands which project to configure.

### Connect Slack

Create a connector and register the agent's Slack route:

```sh
vercel connect create slack --name contentful-agent \
  --triggers --trigger-path /eve/v1/slack
vercel connect attach slack/contentful-agent
```

Follow the browser prompts to connect the agent to your Slack workspace. If you choose another name, use it in the attach command and `SLACK_CONNECTOR` below. Events go to the production deployment at `/eve/v1/slack`. See [eve's Slack guide](https://eve.dev/docs/channels/slack) for event subscriptions and troubleshooting.

### Store each user's writing preferences

The agent saves each user's writing preferences, such as tone or language, in private Vercel Blob storage. If your project already has a private Blob store connected for this purpose, skip this step. Otherwise, create one:

```sh
vercel blob create-store contentful-agent-memory --access private --yes
```

This connects the store to all project environments and sets `BLOB_STORE_ID`. The agent accesses it using Vercel OIDC.

### Configure and deploy

Add the Contentful credentials and Slack connector name:

```sh
vercel env add CONTENTFUL_MANAGEMENT_TOKEN
vercel env add CONTENTFUL_SPACE_IDS
vercel env add SLACK_CONNECTOR
```

Each command prompts for a value and the environments to use it in. Select all environments:

| Variable | Value to enter |
| --- | --- |
| `CONTENTFUL_MANAGEMENT_TOKEN` | Your Contentful Management API token |
| `CONTENTFUL_SPACE_IDS` | Your Contentful space IDs, separated by commas |
| `SLACK_CONNECTOR` | `slack/contentful-agent`, matching the connector created above |

If a variable already exists, repeat its command with `--force` to replace its value in the selected environments. For example:

```sh
vercel env add CONTENTFUL_SPACE_IDS --force
```

Download the environment variables for local use, then deploy:

```sh
vercel env pull .env.local
vercel deploy --prod
```

Invite the agent to a Slack channel and ask it to list your content types. For local testing, use `pnpm dev` after downloading the environment variables.
