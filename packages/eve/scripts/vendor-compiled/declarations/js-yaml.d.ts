declare const tagDefinition: unique symbol;

export interface TagDefinition {
  readonly [tagDefinition]: true;
}

export interface Schema {
  withTags(...tags: TagDefinition[]): Schema;
}

export interface LoadOptions {
  filename?: string;
  schema?: Schema;
}

export const CORE_SCHEMA: Schema;

export const mergeTag: TagDefinition;

export function loadAll(source: string, options?: LoadOptions): unknown[];
