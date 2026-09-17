import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_HEADERS,
  type MemoryByCategory,
  type MemoryCategory,
  type MemoryEntry,
  type MemorySource,
} from "#shared/types/memory";

const HEADER_PATTERN = /^#{1,3}\s*\d*\.?\s*(.+?)\s*$/im;

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function categoryFromHeader(header: string): MemoryCategory | undefined {
  const normalized = normalizeHeader(header);

  for (const category of MEMORY_CATEGORIES) {
    const aliases = MEMORY_CATEGORY_HEADERS[category];
    if (aliases.some((alias) => normalized === alias || normalized.includes(alias))) {
      return category;
    }
  }

  return undefined;
}

function stripCodeFence(raw: string) {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```/);
  return match?.[1]?.trim() ?? trimmed;
}

export function parseMemoryImport(raw: string): Partial<Record<MemoryCategory, string>> {
  const text = stripCodeFence(raw);
  const sections: Partial<Record<MemoryCategory, string>> = {};

  const lines = text.split("\n");
  let currentCategory: MemoryCategory | undefined;
  let buffer: string[] = [];

  function flush() {
    if (!currentCategory || buffer.length === 0) {
      return;
    }

    const content = buffer.join("\n").trim();
    if (content) {
      sections[currentCategory] = sections[currentCategory]
        ? `${sections[currentCategory]}\n\n${content}`
        : content;
    }
    buffer = [];
  }

  for (const line of lines) {
    const headerMatch = line.match(HEADER_PATTERN);
    if (headerMatch?.[1]) {
      const category = categoryFromHeader(headerMatch[1]);
      if (category) {
        flush();
        currentCategory = category;
        continue;
      }
    }

    if (currentCategory) {
      buffer.push(line);
    }
  }

  flush();
  return sections;
}

export function normalizeMemoryContent(content: string) {
  return content.trim().replace(/\s+/g, " ");
}
