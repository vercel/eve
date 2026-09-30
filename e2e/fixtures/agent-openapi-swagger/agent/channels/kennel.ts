import { defineChannel, GET, POST } from "eve/channels";

import { BISCUIT_PET_ID, BISCUIT_VISIT_ID, KENNEL_TOOLS, PET_PHOTO_PNG } from "../../kennel";

type ToolResult = Record<string, unknown>;

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

/** Mirrors `book_visit`'s input schema so a wrongly shaped call fails like a real server. */
function visitProblem(args: Record<string, unknown>): string | undefined {
  if (args.petId !== BISCUIT_PET_ID) return `No boarding pet has id ${String(args.petId)}.`;
  const visit = args.visit as Record<string, unknown> | undefined;
  if (!["checkup", "grooming", "vaccination"].includes(visit?.kind as string)) {
    return "visit.kind must be checkup, grooming, or vaccination.";
  }
  if (typeof visit?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(visit.date)) {
    return "visit.date must be YYYY-MM-DD.";
  }
  const contacts = args.contacts;
  if (
    !Array.isArray(contacts) ||
    contacts.length === 0 ||
    !contacts.every(
      (contact) => typeof contact?.name === "string" && typeof contact?.phone === "string",
    )
  ) {
    return "contacts must be a non-empty list of { name, phone }.";
  }
  return undefined;
}

function callTool(name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case "find_pet": {
      if (typeof args.name !== "string" || !/^biscuit$/iu.test(args.name.trim())) {
        return { ...text(`No boarding pet named ${String(args.name)}.`), isError: true };
      }
      const pet = { petId: BISCUIT_PET_ID, name: "Biscuit", kennel: "B3" };
      return { ...text(JSON.stringify(pet)), structuredContent: pet };
    }
    case "list_feedings":
      return text(
        JSON.stringify([
          { time: "08:00", food: "kibble" },
          { time: "18:00", food: "salmon" },
        ]),
      );
    case "pet_photo":
      return {
        content: [
          { type: "text", text: "Biscuit in kennel B3." },
          { type: "image", data: PET_PHOTO_PNG, mimeType: "image/png" },
        ],
      };
    case "discharge_pet":
      return {
        ...text("Biscuit cannot be discharged while an adoption is in progress."),
        isError: true,
      };
    case "book_visit": {
      const problem = visitProblem(args);
      if (problem !== undefined) return { ...text(problem), isError: true };
      const booking = { visitId: BISCUIT_VISIT_ID, ...args };
      return { ...text(JSON.stringify(booking)), structuredContent: booking };
    }
    default:
      return { ...text(`Unknown tool ${name}.`), isError: true };
  }
}

// A fixture-owned MCP server: eve performs real HTTP discovery and tool calls against it.
export default defineChannel({
  routes: [
    GET("/fixture-kennel/mcp", async () => new Response(null, { status: 405 })),
    POST("/fixture-kennel/mcp", async (request) => {
      const { id, method, params } = (await request.json()) as {
        id?: number | string;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (id === undefined) return new Response(null, { status: 202 });

      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
      switch (method) {
        case "initialize":
          return reply({
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture-kennel", version: "1.0.0" },
          });
        case "tools/list":
          return reply({ tools: KENNEL_TOOLS });
        case "tools/call":
          return reply(callTool(params?.name ?? "", params?.arguments ?? {}));
        default:
          return Response.json({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "Method not found" },
          });
      }
    }),
  ],
});
