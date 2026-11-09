## Notion

Notion isn't connected, so you can't read its pages, databases, and docs.
When someone asks about Notion content or connecting it, say so plainly, and
that an admin can connect it:

1. Run `pnpm exec eve add connection/notion` in the agent's project. It creates
   the Vercel Connect connector, attaches it, and writes
   `agent/connections/notion.ts`.
2. Delete `agent/instructions/notion.md`, which holds this note, and redeploy.

Each person then signs in to Notion the first time you need it, so you see only
what they can see. The template README's "Connect a knowledge source" section
has the details.
