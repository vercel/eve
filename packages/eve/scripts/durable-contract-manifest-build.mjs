import { createHash } from "node:crypto";

import { z } from "zod";

import {
  createDurableContractManifest,
  serializeDurableContractManifest,
} from "../dist/src/internal/durable-contract-registry.js";
import { sessionInboxWireV1Schema } from "../dist/src/execution/wire/session-inbox-wire.v1.js";

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  throw new TypeError(`Canonical JSON cannot encode ${String(value)}.`);
}

export function sha256Schema(schema) {
  return `sha256:${createHash("sha256").update(canonicalJson(schema)).digest("hex")}`;
}

export function buildSchemaHashes() {
  const sessionInboxWireV1JsonSchema = z.toJSONSchema(sessionInboxWireV1Schema, {
    io: "input",
    unrepresentable: "any",
  });
  return {
    dataContracts: {
      sessionInboxWire: { 1: sha256Schema(sessionInboxWireV1JsonSchema) },
    },
  };
}

export function createBuildDurableContractManifest(builtWithEve) {
  return createDurableContractManifest(builtWithEve, buildSchemaHashes());
}

export function serializeBuildDurableContractManifest(builtWithEve) {
  return serializeDurableContractManifest(builtWithEve, buildSchemaHashes());
}
