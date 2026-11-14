/** JSON values in Slack payloads, tool inputs, query results, and persisted state. */
export type JsonValue =
  | undefined
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | JsonObject;
/**
 * JSON object representation permitting absent properties while constructing API and persisted payloads.
 */
export interface JsonObject {
  [key: string]: JsonValue;
}
