// Agents read the packaged docs with whole-file reads, so a long page costs its
// full length even when one section answers the question. The site already
// gives humans progressive disclosure through its sidebar and page outline.
// This gives agents the same: a long page becomes a short outline at its
// original path, with its sections in sibling files. The source and the site
// are unchanged.

/** Pages at or under this many characters ship unchanged. */
export const SPLIT_THRESHOLD = 15_000;
/** Consecutive sections are grouped until a chunk reaches this many characters. */
const MIN_CHUNK = 4_000;
/** A chunk never grows past this many characters by grouping. */
const MAX_CHUNK = 10_000;
/** A section longer than this is split at its `###` headings. */
const MAX_SECTION = 8_000;
/** The first section stays inline in the outline when it is at most this long. */
const MAX_INLINE_FIRST_SECTION = 5_000;

/**
 * Splits a long Markdown page into an outline and section files.
 *
 * @param {string} source - the page's Markdown
 * @param {string} fileName - the page's file name, such as `slack.mdx`
 * @returns {{ outline: string, chunks: Array<{ name: string, content: string }> } | null}
 *   `null` when the page should ship unchanged
 */
export function splitPage(source, fileName) {
  if (source.length <= SPLIT_THRESHOLD) return null;

  const { frontmatter, body } = splitFrontmatter(source);
  const { intro, sections } = splitSections(body);
  if (sections.length < 3) return null;

  const baseName = fileName.replace(/\.mdx?$/u, "");
  const inlineFirst = sections[0].text.length <= MAX_INLINE_FIRST_SECTION;
  const inlined = inlineFirst ? [sections[0]] : [];
  const chunks = groupChunks(
    (inlineFirst ? sections.slice(1) : sections).flatMap((section) => breakLarge(section)),
  );
  if (chunks.length < 2) return null;

  for (const chunk of chunks) {
    const first = chunk.sections[0];
    chunk.name = `${slug(first.heading)}.md`;
  }
  dedupeNames(chunks);

  // Every anchor on the page, mapped to where its heading now lives.
  const anchorHome = new Map();
  for (const section of inlined) {
    for (const anchor of section.anchors) anchorHome.set(anchor, null);
  }
  for (const anchor of headingAnchors(intro)) anchorHome.set(anchor, null);
  for (const chunk of chunks) {
    for (const section of chunk.sections) {
      for (const anchor of section.anchors) anchorHome.set(anchor, chunk.name);
    }
  }

  const title = /^title:\s*"?(.+?)"?\s*$/mu.exec(frontmatter)?.[1] ?? baseName;

  const outlineLinks = (text) =>
    rewriteLinks(text, (target) => {
      if (!target.startsWith("#")) return target;
      const home = anchorHome.get(target.slice(1));
      return home ? `./${baseName}/${home}${target}` : target;
    });

  const sectionLinks = (text, chunkName) =>
    rewriteLinks(text, (target) => {
      if (target.startsWith("#")) {
        const home = anchorHome.get(target.slice(1));
        if (home === chunkName) return target;
        if (home) return `./${home}${target}`;
        return `../${fileName}${target}`;
      }
      return isRelative(target) ? `../${target.replace(/^\.\//u, "")}` : target;
    });

  const listing = chunks
    .map((chunk) => {
      const lines = [`- \`${baseName}/${chunk.name}\``];
      for (const section of chunk.sections) {
        const summary = firstSentence(section.text);
        const subsections = section.subheadings.length
          ? ` Covers: ${section.subheadings.join("; ")}.`
          : "";
        lines.push(`  - **${section.heading}**${summary ? `: ${summary}` : ""}${subsections}`);
      }
      return lines.join("\n");
    })
    .join("\n");

  const outline = [
    frontmatter,
    outlineLinks(intro.trimEnd()),
    ...inlined.map((section) => outlineLinks(section.text.trimEnd())),
    `## More sections

The rest of this page is split into the files below, next to this one. Read only the ones you need; one command can read several, such as \`cat ${baseName}/{${chunks
      .slice(0, 2)
      .map((chunk) => chunk.name.replace(/\.md$/u, ""))
      .join(",")}}.md\`.

${listing}`,
  ]
    .filter((part) => part.trim() !== "")
    .join("\n\n");

  return {
    outline: `${outline}\n`,
    chunks: chunks.map((chunk) => ({
      name: chunk.name,
      content: `> Part of [${title}](../${fileName}).\n\n${chunk.sections
        .map((section) => sectionLinks(section.text.trimEnd(), chunk.name))
        .join("\n\n")}\n`,
    })),
  };
}

function splitFrontmatter(source) {
  const match = /^---\n[\s\S]*?\n---\n/u.exec(source);
  return match
    ? { frontmatter: match[0].trimEnd(), body: source.slice(match[0].length) }
    : { frontmatter: "", body: source };
}

/** Splits at headings of the given level outside code fences. */
function splitSections(body, level = 2) {
  const prefix = `${"#".repeat(level)} `;
  const lines = body.split("\n");
  let fence = null;
  const parts = [{ heading: null, lines: [] }];
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence)) fence = null;
    }
    const heading =
      fence === null && line.startsWith(prefix) ? line.slice(prefix.length) : undefined;
    if (heading !== undefined) parts.push({ heading: heading.trim(), lines: [] });
    parts.at(-1).lines.push(line);
  }
  const [introPart, ...sectionParts] = parts;
  return {
    intro: introPart.lines.join("\n"),
    sections: sectionParts.map((part) => {
      const text = part.lines.join("\n");
      return {
        heading: stripMarkdown(part.heading),
        text,
        anchors: headingAnchors(text),
        subheadings: subheadings(text),
      };
    }),
  };
}

/** Splits an oversized section at its next heading level, keeping the lead with the first part. */
function breakLarge(section, level = 3) {
  if (section.text.length <= MAX_SECTION || level > 4) return [section];
  const { intro, sections: parts } = splitSections(section.text, level);
  if (parts.length < 2) return [section];
  const lead = { ...section, text: intro, anchors: headingAnchors(intro), subheadings: [] };
  return [
    ...(intro.trim().split("\n").length > 1 ? [lead] : []),
    ...parts.flatMap((part) =>
      breakLarge(
        {
          ...part,
          subheadings: headingLines(part.text)
            .filter((heading) => heading.level === level + 1)
            .map((heading) => stripMarkdown(heading.text)),
        },
        level + 1,
      ),
    ),
  ];
}

function groupChunks(sections) {
  const chunks = [];
  for (const section of sections) {
    const last = chunks.at(-1);
    if (last && last.size < MIN_CHUNK && last.size + section.text.length <= MAX_CHUNK) {
      last.sections.push(section);
      last.size += section.text.length;
    } else {
      chunks.push({ sections: [section], size: section.text.length });
    }
  }
  // A tiny chunk, such as a heading with one paragraph, joins the next one.
  for (let index = chunks.length - 2; index >= 0; index -= 1) {
    if (chunks[index].size < 1_500) {
      const [tiny] = chunks.splice(index, 1);
      chunks[index].sections.unshift(...tiny.sections);
      chunks[index].size += tiny.size;
    }
  }
  // A short trailing chunk, often "What to read next", joins the one before it.
  const tail = chunks.at(-1);
  const beforeTail = chunks.at(-2);
  if (
    beforeTail &&
    (tail.size < 1_500 || (tail.size < MIN_CHUNK && beforeTail.size + tail.size <= MAX_CHUNK))
  ) {
    chunks.pop();
    beforeTail.sections.push(...tail.sections);
    beforeTail.size += tail.size;
  }
  return chunks;
}

function dedupeNames(chunks) {
  const seen = new Map();
  for (const chunk of chunks) {
    const count = seen.get(chunk.name) ?? 0;
    seen.set(chunk.name, count + 1);
    if (count > 0) chunk.name = chunk.name.replace(/\.md$/u, `-${count + 1}.md`);
  }
}

function headingLines(text) {
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = /^(#{2,6}) (.+)$/u.exec(line);
    if (match) out.push({ level: match[1].length, text: match[2].trim() });
  }
  return out;
}

function headingAnchors(text) {
  return headingLines(text).map((heading) => slug(heading.text));
}

function subheadings(text) {
  return headingLines(text)
    .filter((heading) => heading.level === 3)
    .map((heading) => stripMarkdown(heading.text));
}

/** The first prose sentence of a section, for the outline. */
function firstSentence(text) {
  let fence = null;
  const paragraph = [];
  for (const line of text.split("\n").slice(1)) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (paragraph.length) break;
      fence = fence === null ? marker : null;
      continue;
    }
    if (fence !== null) continue;
    const trimmed = line.trim();
    if (trimmed === "") {
      if (paragraph.length) break;
      continue;
    }
    if (/^(#|\||<|>|-|\*|\d+\.|!\[|import )/u.test(trimmed)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  const plain = stripMarkdown(paragraph.join(" "));
  const sentence = /^(.+?[.!?:])(\s+[A-Z`*]|$)/u.exec(plain)?.[1] ?? plain;
  return sentence.length > 220 ? `${sentence.slice(0, 217)}...` : sentence;
}

function stripMarkdown(text) {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/\*\*/gu, "");
}

/** GitHub-style heading anchor. */
export function slug(text) {
  return text
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/gu, "-");
}

function isRelative(target) {
  return !/^([a-z][a-z0-9+.-]*:|\/|#)/iu.test(target);
}

/** Rewrites Markdown link targets outside code fences and inline code. */
function rewriteLinks(text, rewrite) {
  let fence = null;
  return text
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
      if (marker) {
        if (fence === null) fence = marker;
        else if (marker.startsWith(fence)) fence = null;
        return line;
      }
      if (fence !== null) return line;
      return line
        .split(/(`[^`]*`)/u)
        .map((part, index) =>
          index % 2 === 1
            ? part
            : part.replace(
                /(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/gu,
                (_, open, target, close) => `${open}${rewrite(target)}${close}`,
              ),
        )
        .join("");
    })
    .join("\n");
}
