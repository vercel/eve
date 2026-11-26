import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import { postChannel } from "../custom-channels/shared";

type MessageResponse = { created?: boolean; ok: boolean; sessionId?: string };

const INLINE_PDF = new TextEncoder().encode("%PDF-1.4\n% Eval inline fixture\n%%EOF\n");

/**
 * Imported user messages accept `{ type: "file" }` parts resolved through the channel's
 * `fetchFile` hook or inline bytes. eve stages each file into the sandbox once, hydrates it on the
 * model request, and records only safe file metadata on `delivery.consumed`.
 */
export default defineEval({
  description:
    "Imported user history file parts resolve through fetchFile and inline bytes with safe stream metadata.",

  async test(t) {
    const ref = `seeded-file-${crypto.randomUUID()}`;
    const created = await postChannel<MessageResponse>(t.target, "/seeded", {
      mode: "create-with-file",
      sessionRef: ref,
    });
    await t.require(created.ok === true && created.created === true, equals(true));

    const watched = t.target.attach(created.sessionId!).watch();
    const sent = await postChannel<MessageResponse>(t.target, "/seeded", {
      message: "Alice again. Which attached files do you see?",
      mode: "send",
      sessionRef: ref,
    });
    await t.require(sent.sessionId, equals(created.sessionId));
    const turn = await watched.result();

    turn.succeeded();
    turn.messageIncludes("contract.pdf (application/pdf)");
    turn.event("delivery.consumed", {
      count: 1,
      data: {
        history: [
          {
            id: "alice-file-1",
            parts: [
              { text: "Hi, this is Alice. Here is our signed contract.", type: "text" },
              {
                filename: "contract.pdf",
                mediaType: "application/pdf",
                type: "file",
                unavailable: true,
              },
            ],
            role: "user",
            text: "Hi, this is Alice. Here is our signed contract.",
          },
          { id: "agent-file-1", role: "assistant", text: "Thanks Alice, I have the contract." },
        ],
      },
    });

    if (!t.target.capabilities.devRoutes) return;

    const evalSession = await t.session({
      history: [
        {
          parts: [
            { text: "Review this invoice.", type: "text" },
            {
              data: INLINE_PDF,
              filename: "invoice.pdf",
              mediaType: "application/pdf",
              type: "file",
            },
          ],
          role: "user",
        },
      ],
    });
    const evalTurn = await evalSession.send("Which attached files do you see?");
    evalTurn.expectOk();
    evalTurn.messageIncludes("invoice.pdf (application/pdf)");
    evalTurn.event("delivery.consumed", {
      count: 1,
      data: {
        history: [
          {
            parts: [
              { text: "Review this invoice.", type: "text" },
              {
                filename: "invoice.pdf",
                mediaType: "application/pdf",
                size: INLINE_PDF.byteLength,
                type: "file",
                unavailable: true,
              },
            ],
            role: "user",
            text: "Review this invoice.",
          },
        ],
      },
    });
  },
});
