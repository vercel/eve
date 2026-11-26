import { defineEval } from "eve/evals";

function createTextPdf(line: string): Uint8Array {
  const escaped = line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT\n/F1 14 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}endstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "utf8"));
}

export default defineEval({
  tags: ["real-model"],
  description:
    "A real model reads an imported PDF attachment from fixed user history and answers a follow-up question from it.",
  async test(t) {
    if (!t.target.capabilities.devRoutes) {
      t.skip("Target has no dev routes; fixed session history is dev-only.");
    }

    const session = await t.session({
      history: [
        {
          role: "user",
          parts: [
            { type: "text", text: "Alice asks: here is the payment schedule PDF." },
            {
              type: "file",
              mediaType: "application/pdf",
              filename: "payment-schedule.pdf",
              data: createTextPdf("First payment due date: March 15, 2027. Amount: $4,200."),
            },
          ],
        },
        {
          role: "assistant",
          text: "Thanks Alice, I received the payment schedule PDF. What would you like to know about it?",
        },
      ],
    });

    const turn = await session.send(
      "When is the first payment due according to the payment schedule PDF I shared?",
    );
    turn.expectOk();
    turn.messageIncludes(/March 15,?\s*2027/i);
    turn.usedNoTools();
    session.event("turn.settled", { count: 1 });
  },
});
