export interface ParseError {
  readonly error: number;
  readonly offset: number;
  readonly length: number;
}

export interface ParseOptions {
  readonly allowEmptyContent?: boolean | undefined;
  readonly allowTrailingComma?: boolean | undefined;
  readonly disallowComments?: boolean | undefined;
}

export declare function parse(text: string, errors?: ParseError[], options?: ParseOptions): unknown;
