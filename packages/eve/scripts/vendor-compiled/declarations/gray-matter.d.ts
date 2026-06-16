// Hand-authored ESM declaration for the vendored slice of `gray-matter`.
// The upstream `gray-matter.d.ts` is `export =` (CJS-style) and cannot be
// re-exported as a default ESM binding without rewriting. Only the surface
// eve touches is typed here: invoking the default function, the static
// `test()` predicate, and the `data`/`content` properties on the result.

export type Input = string | Buffer;

export interface GrayMatterOption<I extends Input, O extends GrayMatterOption<I, O>> {
  parser?: () => void;
  eval?: boolean;
  excerpt?: boolean | ((input: I, options: O) => string);
  excerpt_separator?: string;
  engines?: Record<
    string,
    ((input: string) => object) | { parse(input: string): object; stringify?(data: object): string }
  >;
  language?: string;
  delimiters?: string | [string, string];
}

export interface GrayMatterFile<I extends Input> {
  data: Record<string, unknown>;
  content: string;
  excerpt?: string;
  orig: Buffer | I;
  language: string;
  matter: string;
  stringify(lang: string): string;
}

export interface GrayMatterFunction {
  <I extends Input, O extends GrayMatterOption<I, O>>(
    input: I | { content: I },
    options?: O,
  ): GrayMatterFile<I>;

  test<O extends GrayMatterOption<string, O>>(
    str: string,
    options?: GrayMatterOption<string, O>,
  ): boolean;

  read<O extends GrayMatterOption<string, O>>(
    filepath: string,
    options?: GrayMatterOption<string, O>,
  ): GrayMatterFile<string>;

  stringify<O extends GrayMatterOption<string, O>>(
    file: string | { content: string },
    data: object,
    options?: GrayMatterOption<string, O>,
  ): string;

  language<O extends GrayMatterOption<string, O>>(
    str: string,
    options?: GrayMatterOption<string, O>,
  ): { name: string; raw: string };
}

declare const matter: GrayMatterFunction;

export default matter;
