import { AsyncLocalStorage } from "node:async_hooks";

import { callApi } from "./api";
import { configuredSpaces, environmentId } from "./config";
import { spacePath } from "./model";
import type { RawContentType, RawEntry } from "./types";

interface LocaleContext {
  defaultLocale: string;
  locale: string;
  models: Map<string, Promise<RawContentType>>;
}

const context = new AsyncLocalStorage<LocaleContext>();

/**
 * Reads the locale bound to the current asynchronous Contentful operation.
 *
 * @returns The operation locale, explicit environment override, or en-US for standalone helpers.
 */
export const contentLocale = (): string =>
  context.getStore()?.locale ?? (process.env.CONTENTFUL_LOCALE || "en-US");

/**
 * Runs an operation with the configured override or the space's default Contentful locale.
 *
 * @typeParam T - Result produced by the wrapped operation.
 * @param space - Configured space alias or raw space ID.
 * @param run - Callback executed after resolving its isolated asynchronous locale context.
 * @param signal - Cancellation signal for the locale lookup.
 * @returns The callback's result after completion.
 * @throws {@link Error} When the space is unconfigured or Contentful has no default locale.
 * @remarks Concurrent operations retain separate locale contexts.
 */
export const withContentfulLocale = async <T>(
  space: string,
  run: () => T | Promise<T>,
  signal?: AbortSignal
): Promise<T> => {
  const spaceId = configuredSpaces()[space] ?? space;
  const path = spacePath(spaceId, environmentId());
  const result = await callApi<{
    items: { code: string; default: boolean }[];
  }>(`${path}/locales`, {}, signal);
  const defaultLocale = result.items.find((item) => item.default)?.code;
  if (!defaultLocale) {
    throw new Error("Contentful did not return a default locale.");
  }
  return context.run(
    {
      defaultLocale,
      locale: process.env.CONTENTFUL_LOCALE || defaultLocale,
      models: new Map(),
    },
    run
  );
};

/**
 * Selects the storage locale for an entry field using its content-type definition.
 *
 * @param field - Field definition; shared fields use the environment's default locale.
 * @returns Selected translation locale for localized fields, otherwise the default locale.
 */
export const fieldLocale = (field: { localized?: boolean }): string =>
  field.localized
    ? contentLocale()
    : (context.getStore()?.defaultLocale ?? "en-US");

/**
 * Projects shared entry fields into the selected locale for existing read renderers.
 *
 * @typeParam T - Raw entry shape whose system metadata and other properties are retained.
 * @param base - Space/environment API path containing the entry and its content type.
 * @param entry - Unmodified CMA entry to project for reading.
 * @param signal - Cancellation signal for content-type lookup.
 * @returns Read-only projection; missing translations remain missing and assets are not projected.
 * @remarks Never use this projection for writes or publication traversal. The original entry is
 * unchanged. Content-type reads are cached only within the current asynchronous operation.
 */
export const projectEntryLocale = async <T extends RawEntry>(
  base: string,
  entry: T,
  signal?: AbortSignal
): Promise<T> => {
  const selected = contentLocale();
  const defaultLocale = context.getStore()?.defaultLocale ?? "en-US";
  if (selected === defaultLocale || !entry.fields) {
    return entry;
  }
  const contentTypeId = entry.sys.contentType?.sys.id;
  if (!contentTypeId) {
    throw new Error(
      "Contentful did not return an entry content type for locale selection."
    );
  }
  const path = `${base}/content_types/${contentTypeId}`;
  const models = context.getStore()?.models;
  let pending = models?.get(path);
  if (!pending) {
    pending = callApi<RawContentType>(path, {}, signal);
    models?.set(path, pending);
  }
  const model = await pending;
  if (model.sys.id !== contentTypeId) {
    throw new Error(
      "Contentful returned a different content type than requested."
    );
  }
  const definitions = new Map(model.fields.map((field) => [field.id, field]));
  return {
    ...entry,
    fields: Object.fromEntries(
      Object.entries(entry.fields).map(([key, values]) => {
        const field = definitions.get(key);
        if (!field) {
          // Synthetic projections such as _displayField lack schema metadata.
          return [key, values];
        }
        return [key, { [selected]: values[fieldLocale(field)] }];
      })
    ),
  };
};
