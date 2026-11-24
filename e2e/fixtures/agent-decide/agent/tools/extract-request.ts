import { extract } from "eve/ai";
import { defineTool } from "eve/tools";

import { extractionModel } from "../testing";

export default defineTool({
  description: "Extract fields from Alice's invoice with the fixture extraction provider.",
  inputSchema: {
    type: "object",
    properties: { missingAnswer: { type: "boolean" } },
    required: ["missingAnswer"],
    additionalProperties: false,
  },
  async execute({ missingAnswer }, ctx) {
    const result = await extract({
      model: missingAnswer
        ? { ...extractionModel, doExtract: async () => ({ answers: {}, warnings: [] }) }
        : extractionModel,
      state: "Invoice INV-2041 from Acme Corp. Contacts: Ana, Bo.",
      fields: {
        invoiceNumber: { type: "text", instructions: "The invoice number" },
        contacts: { type: "list", items: "text", instructions: "Contact names" },
      },
      signal: ctx.abortSignal,
    });
    return {
      invoiceNumber: result.answers.invoiceNumber.value,
      source: result.answers.invoiceNumber.source,
      contacts: result.answers.contacts.value,
      usage: result.usage,
    };
  },
});
