import { petstoreHeaders } from "./petstore";

/**
 * A fixture-owned MCP server whose tools cover each shape of MCP result a
 * connection tool returns: structured content, JSON text, images, and tool
 * errors, plus a nested input the model has to build from a signature.
 */
export const KENNEL_TOOLS = [
  {
    name: "find_pet",
    description: "Look up a pet boarding at the kennel by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The pet's name, such as Biscuit." } },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        petId: { type: "integer" },
        name: { type: "string" },
        kennel: { type: "string" },
      },
      required: ["petId", "name", "kennel"],
    },
  },
  {
    name: "list_feedings",
    description: "List a pet's feeding schedule for a day.",
    inputSchema: {
      type: "object",
      properties: {
        petId: { type: "integer" },
        day: { type: "string", enum: ["today", "tomorrow"], default: "today" },
      },
      required: ["petId"],
      additionalProperties: false,
    },
  },
  {
    name: "pet_photo",
    description: "Return the latest photo of a pet.",
    inputSchema: {
      type: "object",
      properties: { petId: { type: "integer" } },
      required: ["petId"],
      additionalProperties: false,
    },
  },
  {
    name: "discharge_pet",
    description: "Send a pet home and close its boarding record.",
    inputSchema: {
      type: "object",
      properties: { petId: { type: "integer" } },
      required: ["petId"],
      additionalProperties: false,
    },
  },
  {
    name: "book_visit",
    description: "Book a care visit for a boarding pet and notify its contacts.",
    inputSchema: {
      type: "object",
      properties: {
        petId: { type: "integer", description: "The id find_pet returns." },
        visit: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["checkup", "grooming", "vaccination"] },
            date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "Visit date as YYYY-MM-DD.",
            },
            notes: { type: "string" },
          },
          required: ["kind", "date"],
          additionalProperties: false,
        },
        contacts: {
          type: "array",
          minItems: 1,
          description: "People to notify about the visit.",
          items: {
            type: "object",
            properties: { name: { type: "string" }, phone: { type: "string" } },
            required: ["name", "phone"],
            additionalProperties: false,
          },
        },
      },
      required: ["petId", "visit", "contacts"],
      additionalProperties: false,
    },
  },
] as const;

export const BISCUIT_PET_ID = 4217;
export const BISCUIT_VISIT_ID = "V-88";

/** A 1x1 PNG, small enough to inline as MCP image content. */
export const PET_PHOTO_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4Mc0IAAO6AZFYX8ZRAAAAAElFTkSuQmCC";

export function kennelUrl(): string {
  const deploymentHost = process.env.VERCEL_URL;
  const host = deploymentHost
    ? `https://${deploymentHost}`
    : (process.env.WORKFLOW_LOCAL_BASE_URL ?? "http://127.0.0.1:3000");
  return `${host}${process.env.EVE_PUBLIC_ROUTE_PREFIX ?? ""}/fixture-kennel/mcp`;
}

/** The kennel reuses the petstore's preview protection bypass. */
export const kennelHeaders = petstoreHeaders;
