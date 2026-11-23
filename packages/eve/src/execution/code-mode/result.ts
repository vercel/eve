import { PROGRAM_MAX_RESULT_TOKENS } from "#execution/code-mode/limits.js";
import type { JsonValue } from "#shared/json.js";
import { defaultToolModelOutput, type ToolModelOutput } from "#tools/model-output.js";

export function truncateProgramModelOutput(output: JsonValue): ToolModelOutput {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? null);
  const budgetBytes = PROGRAM_MAX_RESULT_TOKENS * 4;
  if (Buffer.byteLength(text) <= budgetBytes) {
    return defaultToolModelOutput(output);
  }
  const head = slicePrefixByUtf8Bytes(text, Math.floor(budgetBytes * 0.75));
  const tail = sliceSuffixByUtf8Bytes(text, Math.floor(budgetBytes * 0.25));
  const dropped = text.length - head.length - tail.length;
  if (dropped <= 0) {
    return defaultToolModelOutput(output);
  }
  return {
    type: "text",
    value: `${head}\n… (${String(dropped)} characters left out: the program's result is over ${String(PROGRAM_MAX_RESULT_TOKENS)} tokens. Return only what you need.) …\n${tail}`,
  };
}

function slicePrefixByUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index)!;
    const width = codePoint > 0xffff ? 2 : 1;
    const charBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    index += width;
  }
  return text.slice(0, index);
}

function sliceSuffixByUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let index = text.length;
  while (index > 0) {
    let start = index - 1;
    if (start > 0) {
      const low = text.charCodeAt(start);
      const high = text.charCodeAt(start - 1);
      if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) {
        start -= 1;
      }
    }
    const codePoint = text.codePointAt(start)!;
    const charBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    index = start;
  }
  return text.slice(index);
}
