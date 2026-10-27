import { defineAuthoringCase, emptyProject } from "../../lib/authoring-case.js";
import { tallyAppSetup } from "../../lib/setups/tally-app.js";

// An in-app assistant for an existing Next.js app. It covers eve/next, route auth from the app's
// own session cookie, tenant-scoped tools, per-person memory, uploads, and an eve/react chat
// panel, which the other cases leave out. Each requirement is graded by its own check.
export default defineAuthoringCase({
  startingPoint: emptyProject,
  projectDirectory: "tally",
  setup: tallyAppSetup,
  timeoutSeconds: 1800,
  async interact({ send }) {
    await send(
      [
        "`tally/` is our invoicing app, Tally (Next.js App Router). We want an assistant built into it with eve, so people can ask about invoices and chase payments without clicking around. A teammate already installed the eve package but hasn't written anything yet.",
        "",
        "- The agent should live in the Tally project and run and deploy with it: `npm run dev` starts both, and it ships as part of the same Vercel project.",
        "- Only people signed in to Tally can use it. Use our existing `tally_session` cookie (see `lib/session.ts`); anyone without a valid session gets turned away, in production too.",
        "- It works with invoices through `lib/invoices.ts`, as the signed-in user, within their own organization. It must never see or change another organization's invoices, no matter what anyone types. Add these tools: `find_invoices` (optionally filtered by status or client), `send_reminder` (emails the client a payment reminder for one invoice), and `void_invoice`.",
        "- Voiding can't be undone. Only org owners may void, and even then the assistant has to get the owner's go-ahead in the chat panel before it voids anything.",
        "- People sometimes drop in a client's purchase order and ask for a draft invoice from it. Add a `draft_invoice` tool and let them attach PDFs up to 3 MB. Nothing other than PDFs.",
        "- It should remember each person's preferences, like how firm their reminder emails should be, from one conversation to the next. One person's preferences must never show up for a colleague.",
        "- Put a chat panel on every dashboard page. It needs to show the approve/deny prompt for voids, have a Stop button that stops a reply mid-way, and let people attach a PDF.",
        "- When someone is looking at an invoice and says \"nudge them about this one\", the assistant should know which invoice they mean. Send the page they're on along with each message, but don't let it pile up in the conversation history.",
        "- A conversation should survive a page reload.",
        "",
        "Make sure the project typechecks and `next build` passes.",
      ].join("\n"),
    );
  },
});
