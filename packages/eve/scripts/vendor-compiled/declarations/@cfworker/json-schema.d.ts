export type SchemaDraft = "4" | "7" | "2019-09" | "2020-12";

export interface OutputUnit {
  readonly error: string;
  readonly instanceLocation: string;
  readonly keyword: string;
  readonly keywordLocation: string;
}

export interface ValidationResult {
  readonly errors: readonly OutputUnit[];
  readonly valid: boolean;
}

export declare class Validator {
  constructor(schema: object | boolean, draft?: SchemaDraft, shortCircuit?: boolean);
  validate(instance: unknown): ValidationResult;
}
