import { createHash } from "node:crypto";
import { z } from "zod";
import {
  resolveSlackUser,
  type SlackUserAuthLike,
  type SlackUserIdentity,
} from "#lib/auth.ts";
import { type BlobObjectStore, createBlobObjectStore } from "#lib/blob.ts";

const BLOB_ROOT = "sre-custom-skills";

export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_MARKDOWN_LENGTH = 20_000;

export type SkillScope = "global" | "user";

export interface StoredSkill {
  description: string;
  markdown: string;
  name: string;
  scope: SkillScope;
  updatedAt: string;
}

export interface SaveSkillInput {
  description: string;
  markdown: string;
  name: string;
}

const storedSkillSchema = z.object({
  description: z.string(),
  markdown: z.string(),
  name: z.string(),
  scope: z.enum(["global", "user"]),
  updatedAt: z.string(),
});

export class SkillStoreError extends Error {}

export class MissingHumanUserError extends SkillStoreError {
  constructor() {
    super("A human Slack user is required to create or delete skills.");
    this.name = "MissingHumanUserError";
  }
}

export class InvalidSkillNameError extends SkillStoreError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSkillNameError";
  }
}

export class InvalidSkillContentError extends SkillStoreError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSkillContentError";
  }
}

export class SkillNotFoundError extends SkillStoreError {
  constructor(name: string, scope: SkillScope) {
    super(`No ${scope} skill named "${name}" was found.`);
    this.name = "SkillNotFoundError";
  }
}

function pathSafe(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Fits eve's runtime limit without changing stored names.
 * The underscore separates shortened names from ordinary hyphenated identifiers.
 */
export function getSkillLoadName(name: string): string {
  if (name.length <= 57) {
    return `custom-${name}`;
  }
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 16);
  return `custom_${name.slice(0, 40)}-${suffix}`;
}

export function normalizeSkillName(raw: string): string {
  const normalized = pathSafe(raw.trim())
    .slice(0, MAX_SKILL_NAME_LENGTH)
    .replace(/-+$/g, "");
  if (!normalized) {
    throw new InvalidSkillNameError(
      "Skill name must contain at least one letter or number and becomes a lowercase hyphenated identifier."
    );
  }
  return normalized;
}

function ownerKey(principalId: string): string {
  const key = pathSafe(principalId);
  if (!key) {
    throw new MissingHumanUserError();
  }
  return key;
}

function scopePrefix(
  user: SlackUserIdentity | null,
  scope: SkillScope
): string {
  if (scope === "global") {
    return `${BLOB_ROOT}/global/`;
  }
  if (!user) {
    throw new MissingHumanUserError();
  }
  return `${BLOB_ROOT}/users/${ownerKey(user.principalId)}/`;
}

function skillPath(
  user: SlackUserIdentity,
  scope: SkillScope,
  name: string
): string {
  return `${scopePrefix(user, scope)}${name}.json`;
}

function validateSkillContent(input: SaveSkillInput): {
  name: string;
  description: string;
  markdown: string;
} {
  const name = normalizeSkillName(input.name);
  const description = input.description.trim();
  const markdown = input.markdown.trim();

  if (!description) {
    throw new InvalidSkillContentError("A skill description is required.");
  }
  if (!markdown) {
    throw new InvalidSkillContentError("Skill instructions are required.");
  }
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    throw new InvalidSkillContentError(
      `Skill descriptions must be at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`
    );
  }
  if (markdown.length > MAX_SKILL_MARKDOWN_LENGTH) {
    throw new InvalidSkillContentError(
      `Skill instructions must be at most ${MAX_SKILL_MARKDOWN_LENGTH} characters.`
    );
  }
  if (markdown.includes("\0")) {
    throw new InvalidSkillContentError(
      "Skill instructions cannot contain null characters."
    );
  }

  return { description, markdown, name };
}

const blobObjectStore = createBlobObjectStore();

export class CustomSkillStore {
  private readonly objects: BlobObjectStore;
  private readonly now: () => Date;

  constructor(
    objects: BlobObjectStore = blobObjectStore,
    now: () => Date = () => new Date()
  ) {
    this.objects = objects;
    this.now = now;
  }

  async save(
    auth: SlackUserAuthLike | null | undefined,
    scope: SkillScope,
    input: SaveSkillInput
  ): Promise<StoredSkill> {
    const user = resolveSlackUser(auth);
    if (!user) {
      throw new MissingHumanUserError();
    }
    const { name, description, markdown } = validateSkillContent(input);
    const stored: StoredSkill = {
      description,
      markdown,
      name,
      scope,
      updatedAt: this.now().toISOString(),
    };

    await this.objects.write(
      skillPath(user, scope, name),
      JSON.stringify(stored)
    );
    return stored;
  }

  async list(
    auth: SlackUserAuthLike | null | undefined,
    scope: SkillScope
  ): Promise<StoredSkill[]> {
    const user = resolveSlackUser(auth);
    if (scope === "user" && !user) {
      return [];
    }
    const prefix = scopePrefix(user, scope);
    const pathnames = await this.objects.list(prefix);
    const skills = await Promise.all(
      pathnames.map((pathname) => this.readPath(pathname))
    );

    return skills
      .filter((skill): skill is StoredSkill => skill !== null)
      .sort((first, second) => first.name.localeCompare(second.name));
  }

  async delete(
    auth: SlackUserAuthLike | null | undefined,
    scope: SkillScope,
    rawName: string
  ): Promise<void> {
    const user = resolveSlackUser(auth);
    if (!user) {
      throw new MissingHumanUserError();
    }
    const name = normalizeSkillName(rawName);
    const pathname = skillPath(user, scope, name);
    const existing = await this.readPath(pathname);
    if (!existing || existing.scope !== scope) {
      throw new SkillNotFoundError(name, scope);
    }
    await this.objects.delete(pathname);
  }

  private async readPath(pathname: string): Promise<StoredSkill | null> {
    const content = await this.objects.read(pathname);
    if (!content) {
      return null;
    }

    try {
      return storedSkillSchema.parse(JSON.parse(content));
    } catch (error) {
      console.warn("[sre/custom-skills] skipping malformed skill", {
        error: error instanceof Error ? error.message : String(error),
        pathname,
      });
      return null;
    }
  }
}

const defaultStore = new CustomSkillStore();

export function getCustomSkillStore(): CustomSkillStore {
  return defaultStore;
}
