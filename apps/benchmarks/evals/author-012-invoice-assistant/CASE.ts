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
        "- The assistant is part of Tally, not a separate app: `npm run dev` starts it along with the rest of Tally, and it deploys with Tally to the same Vercel project.",
        "- Only people signed in to Tally can use it. We sign people in with the `tally_session` cookie (see `lib/session.ts`). Everyone else is turned away.",
        "- It works with invoices through `lib/invoices.ts`, acting as the signed-in person within their own organization. It must never see or change another organization's invoices. Give it these tools: `find_invoices` (optionally filtered by status or client), `send_reminder` (emails the client a payment reminder for one invoice), and `void_invoice`.",
        "- Voiding can't be undone. Only org owners can void, and the assistant always checks with the owner in the chat before voiding anything.",
        "- People sometimes drop in a client's purchase order and ask for a draft invoice from it. Add a `draft_invoice` tool and let people attach PDFs up to 3 MB. Only PDFs.",
        "- It remembers each person's preferences, like how firm their reminder emails should be, across conversations. Nobody ever sees a colleague's preferences.",
        "- Put a chat panel on every dashboard page. From it, people can approve or decline a void, stop a reply partway through, and attach a PDF.",
        '- When someone is looking at an invoice and says "nudge them about this one", the assistant knows which invoice they mean without them spelling it out. The page details shouldn\'t show up in the chat or build up in the conversation over time.',
        "- Refreshing the page doesn't lose the conversation.",
        "",
        "Make sure the project typechecks and `next build` passes.",
      ].join("\n"),
    );
  },
});
