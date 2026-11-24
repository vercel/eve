---
title: Field Extraction
description: "Extract typed fields such as invoice numbers, dates, and contact names from text, images, and PDFs in your tools and application code."
---

`extract` from `eve/ai` reads specific fields from content you pass it, such as an invoice number or a list of contact names, and returns each one as a typed value. It uses the [AI SDK extraction API](https://ai-sdk.dev/docs/ai-sdk-core/extractions) with an extraction model, such as [ScaleDown Extract-1](https://vercel.com/ai-gateway/models/extract-1) on Vercel AI Gateway.

The AI SDK extraction model specification is experimental and can change in
patch releases.

## Extract fields inside a tool

Pass a `model`, the `state` to read, and one entry in `fields` for each value you want. eve has no default extraction model, so `model` is required.

```ts title="agent/tools/read-invoice.ts"
import { extract } from "eve/ai";
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Read the invoice number, total, and contacts from an invoice.",
  inputSchema: z.object({ invoice: z.string().min(1).max(20000) }),
  async execute({ invoice }, ctx) {
    const result = await extract({
      model: "scaledown/extract-1",
      state: invoice,
      fields: {
        invoiceNumber: { type: "text", instructions: "The invoice number" },
        contacts: { type: "list", items: "text", instructions: "Contact names" },
      },
      signal: ctx.abortSignal,
    });
    return {
      invoiceNumber: result.answers.invoiceNumber.value, // string | null
      contacts: result.answers.contacts.value, // string[] | null
    };
  },
});
```

Each field's answer appears under its key in `result.answers`, typed from the field: `invoiceNumber.value` is `string | null` and `contacts.value` is `string[] | null`. `usage` holds normalized token usage. `extract` also works outside a tool and doesn't need an active eve session.

Configure Gateway authentication as for any other AI SDK model. During `eve dev`, a Gateway model ID uses the connection selected through `/login`, unless a configured AI SDK default provider resolves string models.

## Read answers

`value` is `null` when the state doesn't contain the field. The other answer properties appear when the model reports them:

| Property     | Meaning                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------- |
| `value`      | The extracted value, or `null` when the state has none.                                      |
| `confidence` | Confidence from 0 to 1 that `value` is correct. Use it to send uncertain results for review. |
| `pNull`      | Probability from 0 to 1 that the state has no value for the field.                           |
| `guess`      | The most likely value, also when `value` is `null`. Not set on list answers.                 |
| `source`     | Where the value appears in the state. Not set on list answers.                               |
| `items`      | On list answers, one `{ confidence, source }` entry per value, in the same order as `value`. |

A `source` names the state part the value came from in `part`. A string or object state is part `0`. A text source also has `start` and `end` offsets into that part's text, counted in UTF-16 code units with `end` exclusive. For a string state, `state.slice(start, end)` returns the matched text.

## Field types

| `type`     | `value` type             | Format and options                                                                                              |
| ---------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `text`     | `string`                 | Free text.                                                                                                      |
| `number`   | `number`                 | `unit`, such as `"USD"`; `integer`; `decimals` from 0 to 6.                                                     |
| `date`     | `string`                 | `YYYY-MM-DD`.                                                                                                   |
| `time`     | `string`                 | `HH:MM` or `HH:MM:SS`.                                                                                          |
| `datetime` | `string`                 | ISO 8601, with an offset when the state has one.                                                                |
| `duration` | `number`                 | A nonnegative length in `unit`: `seconds` (default), `minutes`, `hours`, `days`, `weeks`, `months`, or `years`. |
| `list`     | `string[]` or `number[]` | `items` is `text`, `number`, or `date`. Number items accept `integer` and `decimals`.                           |

Each field takes optional `instructions` as text or JSON. Set `referenceDate` to a `YYYY-MM-DD` date to anchor relative dates, such as "next Friday", and dates without a year.

Models support different field types. Extract-1 extracts text values and lists of text values. A Gateway model ID accepts every field type locally, so the provider rejects types its model doesn't support.

## Extract from PDFs and images

Pass files as `file` parts in a `state` array, with their contents as data:

```ts
import { readFile } from "node:fs/promises";
import { extract } from "eve/ai";

const result = await extract({
  model: "scaledown/extract-1",
  state: [
    {
      type: "file",
      data: await readFile("./invoice.pdf"),
      mediaType: "application/pdf",
    },
  ],
  fields: {
    vendor: { type: "text", instructions: "The company that issued the invoice" },
    total: { type: "text", instructions: "The total amount due" },
    lineItems: { type: "list", items: "text", instructions: "The line items" },
  },
});
```

A `state` array can mix `text`, `file`, and `json` parts. A file part with a URL as its `data` fails, because `extract` doesn't download URLs; fetch the file first and pass its contents.

## Use a provider directly

Pass an extraction model from an installed provider instead of a model ID. The provider owns its credentials and settings. Any provider that implements the AI SDK `Experimental_ExtractionModel` contract works, at specification `v4`. A matching `provider`, `modelId`, and `specificationVersion` alone is not enough.

## Options and errors

`extract` accepts `model`, `state`, `fields`, `referenceDate`, `maxRetries`, `signal`, and `providerOptions`. Pass `signal: ctx.abortSignal` to cancel with the tool call, and `providerOptions: { gateway: { zeroDataRetention: true } }` to keep a Gateway call on providers with zero data retention. Import `ExtractionModel`, `ExtractionState`, `ExtractionStatePart`, `ExtractionInput`, `ExtractionField`, `ExtractionDurationUnit`, `ExtractionValue`, `ExtractionSource`, `ExtractionAnswer`, `ExtractionOptions`, and `ExtractionResult` from `eve/ai` to type reusable configs and handlers.

| What you see                                                      | What to do                                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `extract requires a model, such as "scaledown/extract-1"`         | Pass `model`, because eve has no default extraction model.                                                 |
| An error naming a `fieldId` and an unsupported `fieldType`        | Change the field's type or use a model that supports it.                                                   |
| An error with `fieldIds`, after the model declines some fields    | The model refused those fields. eve returns no partial answers, so retry without them or review the input. |
| `extract requires an installed "ai" package that exports extract` | Install `ai@7.0.176` or later.                                                                             |

Validation, retries, and provider errors otherwise follow AI SDK semantics.

To classify content or answer yes-or-no and scored questions instead of reading values out of it, use [`decide`](./decide#decide-inside-a-tool).
