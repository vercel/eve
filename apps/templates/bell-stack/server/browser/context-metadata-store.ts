import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const metadataSchema = z.object({
  selectedContextId: z.string().optional(),
  contexts: z.record(z.string(), z.object({
    name: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    status: z.enum(["draft", "saved"]).optional(),
    ownerSessionId: z.string().optional(),
    expiresAt: z.iso.datetime().optional(),
  })),
});

export type ContextMetadataFile = z.infer<typeof metadataSchema>;

// All instances in this process share the read/modify/write queue for a path.
const pendingWrites = new Map<string, Promise<void>>();

export class ContextMetadataStore {
  private readonly filePath: string;

  constructor(filePath = defaultMetadataPath()) {
    this.filePath = path.resolve(filePath);
  }

  async read(): Promise<ContextMetadataFile> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { contexts: {} };
      throw error;
    }
    try {
      return metadataSchema.parse(JSON.parse(contents));
    } catch (error) {
      throw new Error("Browser context metadata is invalid; refusing to overwrite it.", { cause: error });
    }
  }

  async add(id: string, name: string, now = new Date()): Promise<void> {
    await this.update((current) => {
      const at = now.toISOString();
      current.contexts[id] = { name, createdAt: at, updatedAt: at };
      current.selectedContextId ??= id;
    });
  }

  async addDraft(
    id: string,
    name: string,
    ownerSessionId: string,
    expiresAt: Date,
    now = new Date(),
  ): Promise<void> {
    await this.update((current) => {
      const at = now.toISOString();
      current.contexts[id] = {
        name,
        createdAt: at,
        updatedAt: at,
        status: "draft",
        ownerSessionId,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async touchDraft(id: string, expiresAt: Date, now = new Date()): Promise<void> {
    await this.update((current) => {
      const context = current.contexts[id];
      if (!context || context.status !== "draft") return false;
      context.updatedAt = now.toISOString();
      context.expiresAt = expiresAt.toISOString();
    });
  }

  async promote(id: string, name: string, now = new Date()): Promise<void> {
    await this.update((current) => {
      const context = current.contexts[id];
      if (!context) throw new Error("Unknown Context.");
      context.name = name;
      context.updatedAt = now.toISOString();
      context.status = "saved";
      delete context.ownerSessionId;
      delete context.expiresAt;
      current.selectedContextId = id;
    });
  }

  async remove(id: string): Promise<void> {
    await this.update((current) => {
      delete current.contexts[id];
      if (current.selectedContextId === id)
        current.selectedContextId = Object.keys(current.contexts)[0];
    });
  }

  async select(id: string): Promise<void> {
    await this.update((current) => {
      if (!current.contexts[id]) throw new Error("Unknown Context.");
      current.selectedContextId = id;
      current.contexts[id].updatedAt = new Date().toISOString();
    });
  }

  private async update(mutate: (value: ContextMetadataFile) => void | false): Promise<void> {
    const operation = (pendingWrites.get(this.filePath) ?? Promise.resolve()).then(async () => {
      const current = await this.read();
      if (mutate(current) !== false) await this.write(current);
    });
    const tail = operation.catch(() => undefined);
    pendingWrites.set(this.filePath, tail);
    try {
      await operation;
    } finally {
      if (pendingWrites.get(this.filePath) === tail) pendingWrites.delete(this.filePath);
    }
  }

  private async write(value: ContextMetadataFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

declare global {
  var __bellContextMetadataStore: ContextMetadataStore | undefined;
}

export function getContextMetadataStore(): ContextMetadataStore {
  globalThis.__bellContextMetadataStore ??= new ContextMetadataStore();
  return globalThis.__bellContextMetadataStore;
}

function defaultMetadataPath(): string {
  return process.env.BELL_CONTEXT_METADATA_PATH
    ? path.resolve(process.env.BELL_CONTEXT_METADATA_PATH)
    : path.join(process.cwd(), ".bell", "contexts.json");
}
