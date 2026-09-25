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

export interface Edit {
  readonly offset: number;
  readonly length: number;
  readonly content: string;
}

export interface FormattingOptions {
  readonly insertSpaces?: boolean;
  readonly tabSize?: number;
  readonly eol?: string;
}

export declare function parse(text: string, errors?: ParseError[], options?: ParseOptions): unknown;
export declare function modify(
  text: string,
  path: (string | number)[],
  value: unknown,
  options?: { formattingOptions?: FormattingOptions },
): Edit[];
export declare function applyEdits(text: string, edits: Edit[]): string;
