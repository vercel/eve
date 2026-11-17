import { callApi } from "./api";
/**
 * Content-type discovery and pagination metadata, without persistent schema caching.
 *
 * @packageDocumentation
 */
import { environmentId } from "./config";
import { contentfulSchemaInputSchema } from "./input-schemas";
import type { ContentfulSchemaInput } from "./input-schemas";
import type { ContentfulSpaceId } from "./model";
import { QUERY_SPACES, RICH_TEXT_REFERENCE_NODES, spacePath } from "./model";
import type { Collection, ContentTypeField, RawContentType } from "./types";

/* CMA pagination; a null total means completeness cannot be inferred from a count. */
/**
 * CMA pagination metadata; a null total preserves uncertainty about the complete result count.
 */
export interface QueryPagination {
  limit: number;
  nextSkip: number | null;
  skip: number;
  total: number | null;
}

/* Normalized authoring constraints for one field, including rich-text references. */
interface ContentfulSchemaField {
  allowedContentTypeIds: string[] | null;
  id: string;
  items: {
    allowedContentTypeIds: string[] | null;
    linkType: string | null;
    type: string;
  } | null;
  linkType: string | null;
  localized: boolean;
  name: string;
  required: boolean;
  richTextReferences: ReturnType<typeof richTextReferences>;
  type: string;
}

interface ContentfulTypeSummary {
  displayField: string | null;
  id: string;
  name: string;
}

/* A single model or one page of the model catalog, selected by the input. */
type ContentfulSchemaResult = {
  environmentId: string;
  spaceId: ContentfulSpaceId;
} & (
  | { contentType: ContentfulTypeSummary & { fields: ContentfulSchemaField[] } }
  | (QueryPagination & {
      contentType?: undefined;
      contentTypes: ContentfulTypeSummary[];
    })
);

/**
 * Describe the next page without inventing a missing total count.
 *
 * @typeParam T - The item structure; only the collection's length and total affect pagination.
 * @param collection - Current CMA page, whose total may be absent.
 * @param limit - Requested page size, already validated by the caller.
 * @param skip - Offset used to fetch the current page.
 * @returns Pagination metadata; null total is unknown, and null nextSkip ends this traversal.
 * @remarks With an unknown total, a full page offers continuation while a short page does not.
 */
export const queryPagination = <T>(
  collection: Collection<T>,
  limit: number,
  skip: number
): QueryPagination => {
  const total = collection.total ?? null;
  const next = skip + collection.items.length;
  return {
    limit,
    nextSkip:
      collection.items.length > 0 &&
      (total === null ? collection.items.length === limit : next < total)
        ? next
        : null,
    skip,
    total,
  };
};

const referenceTargets = (fieldDefinition: ContentTypeField) => {
  const targets =
    fieldDefinition.validations?.flatMap(
      (validation) => validation.linkContentType ?? []
    ) ?? [];
  return fieldDefinition.linkType === "Entry" && targets.length > 0
    ? [...new Set(targets)]
    : null;
};

/* Current same-space rich-text permissions, not evidence of actual entry usage. */
const richTextReferences = (fieldDefinition: ContentTypeField) => {
  if (fieldDefinition.type !== "RichText") {
    return null;
  }
  const validations = fieldDefinition.validations ?? [];
  return RICH_TEXT_REFERENCE_NODES.filter(([nodeType]) =>
    validations.every(
      (validation) =>
        validation.enabledNodeTypes === undefined ||
        validation.enabledNodeTypes.includes(nodeType)
    )
  ).map(([nodeType, linkType]) => {
    const restrictions = validations.flatMap((validation) =>
      (validation.nodes?.[nodeType] ?? []).flatMap((nodeValidation) =>
        nodeValidation.linkContentType === undefined
          ? []
          : [nodeValidation.linkContentType]
      )
    );
    // Multiple validation rules must all pass. Preserve an explicitly empty list.
    const allowedContentTypeIds =
      linkType === "Entry" && restrictions.length > 0
        ? [...new Set(restrictions[0])].filter((id) =>
            restrictions.every((ids) => ids.includes(id))
          )
        : null;
    return { allowedContentTypeIds, linkType, nodeType };
  });
};

/**
 * Describes one content-type field for the model: type, constraints, and allowed link targets.
 *
 * @param field - Field definition from a CMA content type.
 * @returns Field identity, data type, required/localized flags, and reference restrictions.
 * @remarks Shared by the live schema tool and the schema stored with the searchable copy.
 */
export const describeContentTypeField = (
  field: RawContentType["fields"][number]
) => ({
  allowedContentTypeIds: referenceTargets(field),
  id: field.id,
  items: field.items
    ? {
        allowedContentTypeIds: referenceTargets(field.items),
        linkType: field.items.linkType ?? null,
        type: field.items.type,
      }
    : null,
  linkType: field.linkType ?? null,
  localized: field.localized ?? false,
  name: field.name,
  required: field.required ?? false,
  richTextReferences: richTextReferences(field),
  type: field.type,
});

/**
 * List content types or inspect one model without persistent schema caching.
 *
 * @param input - Schema input; null contentTypeId lists a catalog page, with null limit/skip meaning 25/0.
 * @param signal - Optional cancellation passed to the CMA request.
 * @returns Either one model's fields/reference restrictions or a paginated catalog.
 * @throws {@link Error} If input validation, the CMA request, cancellation, or response decoding fails.
 * @remarks Returned constraints describe the model, not actual entry usage or full write validity.
 */
export const getContentfulSchema = async (
  input: ContentfulSchemaInput,
  signal?: AbortSignal
): Promise<ContentfulSchemaResult> => {
  const {
    space,
    contentTypeId,
    limit: requestedLimit,
    skip: requestedSkip,
  } = contentfulSchemaInputSchema.parse(input);
  const spaceId = QUERY_SPACES[space];
  const base = spacePath(spaceId);
  if (contentTypeId !== null) {
    const model = await callApi<RawContentType>(
      `${base}/content_types/${contentTypeId}`,
      {},
      signal
    );
    return {
      contentType: {
        displayField: model.displayField ?? null,
        fields: model.fields.map(describeContentTypeField),
        id: model.sys.id,
        name: model.name,
      },
      environmentId: environmentId(),
      spaceId,
    };
  }
  const limit = requestedLimit ?? 25;
  const skip = requestedSkip ?? 0;
  const collection = await callApi<Collection<RawContentType>>(
    `${base}/content_types`,
    {
      limit: String(limit),
      order: "sys.id",
      skip: String(skip),
    },
    signal
  );
  return {
    environmentId: environmentId(),
    spaceId,
    ...queryPagination(collection, limit, skip),
    contentTypes: collection.items.map((model) => ({
      displayField: model.displayField ?? null,
      id: model.sys.id,
      name: model.name,
    })),
  };
};
