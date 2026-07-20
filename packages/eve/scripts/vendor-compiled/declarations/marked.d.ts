export interface Token {
  readonly type: string;
  readonly raw?: string;
  readonly text?: string;
  readonly depth?: number;
  readonly lang?: string;
  readonly ordered?: boolean;
  readonly start?: number | string;
  readonly checked?: boolean;
  readonly href?: string;
  readonly title?: string | null;
  readonly tokens?: readonly Token[];
  readonly items?: readonly Token[];
  readonly header?: readonly TableCell[];
  readonly rows?: readonly (readonly TableCell[])[];
  readonly align?: readonly ("center" | "left" | "right" | null)[];
}

export interface TableCell {
  readonly text: string;
  readonly tokens: readonly Token[];
}

export function lexer(markdown: string): readonly Token[];
