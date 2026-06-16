export interface Options {
  headingStyle?: "setext" | "atx" | undefined;
  hr?: string | undefined;
  bulletListMarker?: "-" | "+" | "*" | undefined;
  codeBlockStyle?: "indented" | "fenced" | undefined;
  emDelimiter?: "_" | "*" | undefined;
}

export default class TurndownService {
  constructor(options?: Options);
  remove(filter: string | readonly string[]): this;
  turndown(html: string): string;
}
