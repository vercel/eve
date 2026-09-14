import { mockModel } from "eve/evals";

export const SOFTWARE_FACTORY_EVAL_MARKER = "SOFTWARE_FACTORY_PIPELINE";

export interface FactoryTicket {
  readonly area: string;
  readonly id: string;
  readonly reviewKey?: string;
  readonly severity: string;
  readonly title: string;
  readonly triageKey?: string;
}

export interface FactoryTriage {
  readonly derivedKey: string;
  readonly priorityTicket: string;
  readonly ticketCount: number;
}

export interface FactoryReview {
  readonly accepted: boolean;
  readonly derivedKey: string;
  readonly ticketCount: number;
}

export interface FactoryReproduction {
  readonly combinedKey: string;
  readonly sampleTicket: string;
  readonly testCase: string;
}

export interface FactoryOutput {
  readonly reproduction: FactoryReproduction;
  readonly review: FactoryReview;
  readonly triage: FactoryTriage;
}

export function expectedFactoryOutput(token: string): FactoryOutput {
  const triage: FactoryTriage = {
    derivedKey: `${token}:triage`,
    priorityTicket: "T-000",
    ticketCount: 200,
  };
  const review: FactoryReview = {
    accepted: true,
    derivedKey: `${token}:review`,
    ticketCount: 200,
  };
  return {
    reproduction: {
      combinedKey: `${triage.derivedKey}|${review.derivedKey}`,
      sampleTicket: triage.priorityTicket,
      testCase: `test("${token}", () => expect(runSyntheticRegression()).not.toThrow());`,
    },
    review,
    triage,
  };
}

export function buildSoftwareFactoryProgram(token: string): string {
  return `
const tickets = Array.from({ length: 200 }, (_, index) => {
  const ticket = {
    id: \`T-\${String(index).padStart(3, "0")}\`,
    area: ["api", "cli", "runtime", "docs"][index % 4],
    severity: ["critical", "high", "medium", "low"][index % 4],
    title: \`Synthetic regression \${index}\`,
  };
  if (index === 0) ticket.triageKey = "${token}:triage";
  if (index === 199) ticket.reviewKey = "${token}:review";
  return ticket;
});
const [triage, review] = await Promise.all([
  tools["ticket-triage"]({
    message: JSON.stringify({ tickets }),
    outputSchema: ${JSON.stringify(TRIAGE_SCHEMA)},
  }),
  tools["ticket-review"]({
    message: JSON.stringify({ tickets }),
    outputSchema: ${JSON.stringify(REVIEW_SCHEMA)},
  }),
]);
const reproduction = await tools["ticket-reproducer"]({
  message: JSON.stringify({ review, triage }),
  outputSchema: ${JSON.stringify(REPRODUCTION_SCHEMA)},
});
return { reproduction, review, triage };
`.trim();
}

export const softwareFactoryRootModel = mockModel({
  modelId: "software-factory-root",
  respond(request) {
    const workflowResult = [...request.toolResults]
      .reverse()
      .find((result) => result.name === "workflow")?.output;
    if (workflowResult !== undefined) {
      return typeof workflowResult === "string" ? workflowResult : JSON.stringify(workflowResult);
    }
    const token = /FACTORY_RUN_TOKEN=([A-Za-z0-9-]+)/u.exec(request.lastUserMessage ?? "")?.[1];
    if (token === undefined) throw new Error("Software factory prompt has no run token.");
    return {
      toolCalls: [{ name: "workflow", input: { js: buildSoftwareFactoryProgram(token) } }],
    };
  },
});

export function createSoftwareFactoryStageModel(stage: "reproduce" | "review" | "triage") {
  return mockModel({
    modelId: `software-factory-${stage}`,
    respond(request) {
      const payload = readCallerPayload(request.lastUserMessage);
      let output: FactoryReproduction | FactoryReview | FactoryTriage;
      if (stage === "triage") {
        const tickets = readTickets(payload.tickets);
        const derivedKey = tickets.find((ticket) => ticket.triageKey !== undefined)?.triageKey;
        if (derivedKey === undefined) throw new Error("Triage input has no derived key.");
        output = { derivedKey, priorityTicket: tickets[0]!.id, ticketCount: tickets.length };
      } else if (stage === "review") {
        const tickets = readTickets(payload.tickets);
        const derivedKey = tickets.find((ticket) => ticket.reviewKey !== undefined)?.reviewKey;
        if (derivedKey === undefined) throw new Error("Review input has no derived key.");
        output = { accepted: true, derivedKey, ticketCount: tickets.length };
      } else {
        const triage = payload.triage as FactoryTriage;
        const review = payload.review as FactoryReview;
        const token = triage.derivedKey.replace(/:triage$/u, "");
        output = {
          combinedKey: `${triage.derivedKey}|${review.derivedKey}`,
          sampleTicket: triage.priorityTicket,
          testCase: `test("${token}", () => expect(runSyntheticRegression()).not.toThrow());`,
        };
      }
      return { toolCalls: [{ name: "final_output", input: output }] };
    },
  });
}

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    derivedKey: { type: "string" },
    priorityTicket: { type: "string" },
    ticketCount: { type: "integer" },
  },
  required: ["derivedKey", "priorityTicket", "ticketCount"],
  additionalProperties: false,
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    accepted: { type: "boolean" },
    derivedKey: { type: "string" },
    ticketCount: { type: "integer" },
  },
  required: ["accepted", "derivedKey", "ticketCount"],
  additionalProperties: false,
};

const REPRODUCTION_SCHEMA = {
  type: "object",
  properties: {
    combinedKey: { type: "string" },
    sampleTicket: { type: "string" },
    testCase: { type: "string" },
  },
  required: ["combinedKey", "sampleTicket", "testCase"],
  additionalProperties: false,
};

function readCallerPayload(message: string | null): Record<string, unknown> {
  const marker = "Caller message:\n";
  const markerIndex = message?.lastIndexOf(marker) ?? -1;
  if (message === null || markerIndex < 0) {
    throw new Error("Software factory stage received no caller payload.");
  }
  return JSON.parse(message.slice(markerIndex + marker.length)) as Record<string, unknown>;
}

function readTickets(value: unknown): FactoryTicket[] {
  if (!Array.isArray(value)) throw new Error("Software factory input has no ticket array.");
  return value as FactoryTicket[];
}
