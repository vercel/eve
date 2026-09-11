import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import {
  MEMORY_CATEGORIES,
  type MemoryByCategory,
  type MemoryCategory,
  type MemoryEntry,
  type MemorySource,
} from "#shared/types/memory";
import { normalizeMemoryContent, parseMemoryImport } from "~~/server/utils/memory-import";

function emptyByCategory(): MemoryByCategory {
  return {
    work_context: [],
    personal_context: [],
    active_focus: [],
    instructions_preferences: [],
    project_history: [],
  };
}

function rowToEntry(row: typeof schema.userMemory.$inferSelect): MemoryEntry {
  return {
    id: row.id,
    category: row.category as MemoryCategory,
    content: row.content,
    source: row.source as MemorySource,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export async function listMemoryForUser(userId: string): Promise<MemoryByCategory> {
  const rows = await db
    .select()
    .from(schema.userMemory)
    .where(eq(schema.userMemory.userId, userId))
    .orderBy(asc(schema.userMemory.createdAt));

  const grouped = emptyByCategory();
  for (const row of rows) {
    const category = row.category as MemoryCategory;
    if (MEMORY_CATEGORIES.includes(category)) {
      grouped[category].push(rowToEntry(row));
    }
  }

  return latestEntryPerCategory(grouped);
}

function latestEntryPerCategory(grouped: MemoryByCategory): MemoryByCategory {
  const result = emptyByCategory();

  for (const category of MEMORY_CATEGORIES) {
    const entries = grouped[category];
    if (!entries.length) {
      continue;
    }

    result[category] = [
      entries.reduce((latest, entry) => (entry.updatedAt >= latest.updatedAt ? entry : latest)),
    ];
  }

  return result;
}

async function getLatestMemoryForCategory(userId: string, category: MemoryCategory) {
  const rows = await db
    .select()
    .from(schema.userMemory)
    .where(and(eq(schema.userMemory.userId, userId), eq(schema.userMemory.category, category)))
    .orderBy(asc(schema.userMemory.updatedAt));

  const entry = rows.at(-1);
  return entry ? rowToEntry(entry) : undefined;
}

export async function setMemoryForCategory(
  userId: string,
  input: { category: MemoryCategory; content: string; source: MemorySource },
) {
  const content = input.content.trim();
  if (!content) {
    throw createError({
      statusCode: 400,
      statusMessage: "Memory content cannot be empty",
    });
  }

  const latest = await getLatestMemoryForCategory(userId, input.category);
  if (latest && normalizeMemoryContent(latest.content) === normalizeMemoryContent(content)) {
    return { entry: latest, saved: false as const, reason: "unchanged" as const };
  }

  await db
    .delete(schema.userMemory)
    .where(
      and(eq(schema.userMemory.userId, userId), eq(schema.userMemory.category, input.category)),
    );

  const id = crypto.randomUUID();
  await db.insert(schema.userMemory).values({
    id,
    userId,
    category: input.category,
    content,
    source: input.source,
  });

  const [row] = await db
    .select()
    .from(schema.userMemory)
    .where(eq(schema.userMemory.id, id))
    .limit(1);

  return {
    entry: row ? rowToEntry(row) : undefined,
    saved: true as const,
  };
}

export async function importMemoryForUser(userId: string, raw: string) {
  const sections = parseMemoryImport(raw);
  const created: MemoryEntry[] = [];
  const skipped: MemoryCategory[] = [];

  for (const category of MEMORY_CATEGORIES) {
    const content = sections[category]?.trim();
    if (!content) {
      continue;
    }

    const result = await setMemoryForCategory(userId, {
      category,
      content,
      source: "import",
    });

    if (result.saved && result.entry) {
      created.push(result.entry);
    } else if (!result.saved && result.reason === "unchanged") {
      skipped.push(category);
    }
  }

  return { created, skipped, memory: await listMemoryForUser(userId) };
}

export async function deleteMemoryEntry(userId: string, id: string) {
  const [existing] = await db
    .select()
    .from(schema.userMemory)
    .where(and(eq(schema.userMemory.id, id), eq(schema.userMemory.userId, userId)))
    .limit(1);

  if (!existing) {
    return false;
  }

  await db
    .delete(schema.userMemory)
    .where(
      and(eq(schema.userMemory.userId, userId), eq(schema.userMemory.category, existing.category)),
    );

  return true;
}

export async function updateMemoryEntry(userId: string, id: string, content: string) {
  const trimmed = content.trim();
  if (!trimmed) {
    throw createError({
      statusCode: 400,
      statusMessage: "Memory content cannot be empty",
    });
  }

  const [existing] = await db
    .select()
    .from(schema.userMemory)
    .where(and(eq(schema.userMemory.id, id), eq(schema.userMemory.userId, userId)))
    .limit(1);

  if (!existing) {
    return undefined;
  }

  await db
    .update(schema.userMemory)
    .set({ content: trimmed, source: "manual" })
    .where(eq(schema.userMemory.id, id));

  const [row] = await db
    .select()
    .from(schema.userMemory)
    .where(eq(schema.userMemory.id, id))
    .limit(1);

  return row ? rowToEntry(row) : undefined;
}
