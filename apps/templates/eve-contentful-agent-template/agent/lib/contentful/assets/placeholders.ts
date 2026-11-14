import type { z } from "zod";

import { isObject, isString } from "../../values";
/* Resolve asset placeholders consistently for creation and batch updates. */
import type { ContentfulAssetPlan } from "./workflow";

type AssetFieldValue = z.core.util.JSONType;

/**
 * Replaces scalar or array newAsset placeholders with reserved Contentful asset links.
 *
 * @typeParam T - Field-change record whose other properties are preserved.
 * @param inputFields - Field values containing optional declared-asset placeholders.
 * @param resources - Reserved asset identities indexed by their caller-provided keys.
 * @returns Field records with placeholders replaced by Asset links.
 * @throws {@link Error} When keys repeat, references are invalid, or a declared asset is unused.
 */
export const resolveAssetFields = <T extends { value: AssetFieldValue }>(
  inputFields: T[],
  resources: ContentfulAssetPlan["assets"]
) => {
  const ids = new Map(resources.map((asset) => [asset.key, asset.id]));
  if (ids.size !== resources.length) {
    throw new Error("Duplicate asset keys are not allowed.");
  }
  const used = new Set<string>();
  const replace = (value: AssetFieldValue): AssetFieldValue => {
    if (!(value && isObject(value) && "newAsset" in value)) {
      return value;
    }
    if (
      Object.keys(value).length !== 1 ||
      !isString(value.newAsset) ||
      !ids.has(value.newAsset)
    ) {
      throw new Error(
        "Each newAsset reference must contain only a declared asset key."
      );
    }
    used.add(value.newAsset);
    return {
      sys: {
        id: ids.get(value.newAsset) ?? "",
        linkType: "Asset",
        type: "Link",
      },
    };
  };
  const fields = inputFields.map(({ value, ...field }) => ({
    ...field,
    value: Array.isArray(value) ? value.map(replace) : replace(value),
  }));
  if (used.size !== ids.size) {
    throw new Error(
      "Every declared asset must be referenced by an entry field."
    );
  }
  return fields;
};
