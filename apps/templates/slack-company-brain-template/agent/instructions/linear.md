## Linear

Linear isn't connected, so you can't read its issues, projects, and cycles.
When someone asks about Linear content or connecting it, say so plainly, and
that an admin can connect it:

1. Run `pnpm exec eve add connection/linear` in the agent's project. It creates
   the Vercel Connect connector, attaches it, and writes
   `agent/connections/linear.ts`.
2. Delete `agent/instructions/linear.md`, which holds this note, and redeploy.

Each person then signs in to Linear the first time you need it, so you see only
what they can see. The template README's "Connect a knowledge source" section
has the details.
