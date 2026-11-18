/** JSON values stored in Contentful fields, Slack payloads, and persisted operation plans. */
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
