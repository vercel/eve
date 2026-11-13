"use client";

import type { InferComponentProps } from "@json-render/core";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import type { Spec } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
import {
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  ExternalLinkIcon,
  ImageIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import { cn } from "@/lib/utils";

import {
  isSafeImageUrl,
  isSafeLinkUrl,
  uiCatalog,
  uiSpecSchema as strictUiSpecSchema,
} from "../../../../agent/lib/ui-catalog";
import { getPreviewImage } from "../preview-image";
import { DataTable } from "./data-table";

/** Props of a `ResultCard` element, as the catalog defines them. */
type ResultCardProps = InferComponentProps<typeof uiCatalog, "ResultCard">;

/** Renders `render_ui` specs with shadcn components plus the chat's own cards. */
const { registry: uiRegistry } = defineRegistry(uiCatalog, {
  components: {
    Accordion: shadcnComponents.Accordion,
    Alert: shadcnComponents.Alert,
    Avatar: (context) => (
      <shadcnComponents.Avatar
        {...context}
        props={{ ...context.props, src: safeImageUrl(context.props.src) }}
      />
    ),
    Badge: shadcnComponents.Badge,
    Card: shadcnComponents.Card,
    CardRow: ({ children }) => <CardRow>{children}</CardRow>,
    Grid: shadcnComponents.Grid,
    Heading: ({ props }) => <ChatHeading {...props} />,
    Image: ({ props }) => <CaptionedImage {...props} />,
    KeyValue: ({ props }) => <KeyValueList items={props.items} />,
    Link: ({ props }) => <TextLink {...props} />,
    Metric: ({ props }) => <Metric {...props} />,
    Progress: ({ props }) => <ProgressBar {...props} />,
    ResultCard: ({ props }) => <ResultCard card={props} />,
    Separator: shadcnComponents.Separator,
    Stack: shadcnComponents.Stack,
    Steps: ({ props }) => <StepList items={props.items} />,
    Table: ({ props }) => <DataTable {...props} />,
    Text: ({ props }) => <ChatText {...props} />,
  },
});

/**
 * Parses a `render_ui` tool input against the shared catalog, props included.
 * Parsing fails while the input is still streaming in or when it is invalid.
 */
export const uiSpecSchema = z.custom<Spec>(
  (value) => strictUiSpecSchema.safeParse(value).success
);

/**
 * Renders a validated `render_ui` spec.
 *
 * @param props - The component props.
 * @returns The generated UI.
 */
export function GeneratedUi({
  spec,
}: {
  /** The spec to render. */
  readonly spec: Spec;
}) {
  return (
    <JSONUIProvider initialState={spec.state ?? {}} registry={uiRegistry}>
      <div className="w-full">
        <Renderer registry={uiRegistry} spec={spec} />
      </div>
    </JSONUIProvider>
  );
}

/**
 * Drops an image URL that breaks the catalog's rule, in case a spec reaches the
 * renderer without passing it.
 *
 * @param url - The agent's image URL.
 * @returns The URL when it is absolute https, otherwise `null`.
 */
function safeImageUrl(url: string | null): string | null {
  return url !== null && isSafeImageUrl(url) ? url : null;
}

/**
 * Drops a link URL that breaks the catalog's rule, such as a `javascript:` URL.
 *
 * @param url - The agent's link URL.
 * @returns The URL when it is absolute http or https, otherwise `null`.
 */
function safeLinkUrl(url: string | null): string | null {
  return url !== null && isSafeLinkUrl(url) ? url : null;
}

/**
 * A row that shows two children at a time and scrolls sideways for the rest.
 *
 * @param props - The component props.
 * @returns The scrolling row.
 */
function CardRow({
  children,
}: {
  /** The cards to lay out. */
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex snap-x snap-mandatory scrollbar-thin gap-3 overflow-x-auto pb-2 [&>*]:shrink-0 [&>*]:basis-[calc(50%-0.375rem)] [&>*]:snap-start">
      {children}
    </div>
  );
}

/**
 * One result card: an image or placeholder, then the title and details.
 * The whole card links out when the result has a URL.
 *
 * @param props - The component props.
 * @returns The card.
 */
function ResultCard({
  card,
}: {
  /** The result to show. */
  readonly card: ResultCardProps;
}) {
  const url = safeLinkUrl(card.url);
  const body = (
    <>
      <CardImage pageUrl={url} src={card.imageUrl} />
      <div className="space-y-1.5 p-3">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium">
            {card.title}
          </p>
          {url === null ? null : (
            <ExternalLinkIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
          )}
        </div>
        {card.subtitle === null ? null : (
          <p className="text-muted-foreground truncate text-xs">
            {card.subtitle}
          </p>
        )}
        {card.description === null ? null : (
          <p className="text-muted-foreground line-clamp-3 text-sm">
            {card.description}
          </p>
        )}
      </div>
    </>
  );

  const className =
    "bg-card flex h-full flex-col overflow-hidden rounded-lg border text-left";

  return url === null ? (
    <div className={className}>{body}</div>
  ) : (
    <a
      className={`${className} hover:bg-muted/40 transition-colors`}
      href={url}
      rel="noreferrer"
      target="_blank"
    >
      {body}
    </a>
  );
}

/**
 * Looks up a page's preview image on the server.
 *
 * @param pageUrl - The page to read, or `null` to skip the lookup.
 * @returns The preview image URL once found, otherwise `undefined`.
 */
function usePreviewImage(pageUrl: string | null): string | undefined {
  const [preview, setPreview] = useState<{
    readonly image: string | null;
    readonly pageUrl: string;
  }>();

  useEffect(() => {
    let active = true;
    const load = async (url: string) => {
      const image = await getPreviewImage({ data: { url } });
      if (active) {
        setPreview({ image, pageUrl: url });
      }
    };
    if (pageUrl !== null) {
      void load(pageUrl);
    }
    return () => {
      active = false;
    };
  }, [pageUrl]);

  return preview?.pageUrl === pageUrl
    ? (preview.image ?? undefined)
    : undefined;
}

/**
 * The card's image. Falls back to the linked page's preview image when the
 * card has no image or its image fails to load, then to a placeholder.
 *
 * @param props - The component props.
 * @returns The image or placeholder.
 */
function CardImage({
  alt = "",
  pageUrl = null,
  src,
}: {
  /** What the image shows; empty for decorative card images. */
  readonly alt?: string;
  /** The page the card links to, used to find a preview image. */
  readonly pageUrl?: string | null;
  /** The image URL, if the result has one. */
  readonly src: string | null;
}) {
  const [failed, setFailed] = useState<readonly string[]>([]);
  const ownImage = safeImageUrl(src);
  const hasOwnImage = ownImage !== null && !failed.includes(ownImage);
  const preview = usePreviewImage(hasOwnImage ? null : pageUrl);
  const previewUsable = preview !== undefined && !failed.includes(preview);
  const fallback = previewUsable ? preview : undefined;
  const image = hasOwnImage ? ownImage : fallback;

  if (image === undefined) {
    return (
      <div
        aria-hidden="true"
        className="bg-muted flex aspect-video w-full items-center justify-center"
      >
        <ImageIcon className="text-muted-foreground/40 size-8" />
      </div>
    );
  }

  return (
    <img
      alt={alt}
      className="bg-muted aspect-video w-full object-cover"
      loading="lazy"
      onError={() => {
        setFailed((current) => [...current, image]);
      }}
      referrerPolicy="no-referrer"
      src={image}
    />
  );
}

/**
 * A dashboard number: a muted label, the value, and an optional change line
 * colored by trend.
 *
 * @param props - The component props.
 * @returns The metric.
 */
function Metric({
  change,
  label,
  trend,
  value,
}: {
  /** What changed, e.g. "+8% this week". */
  readonly change: string | null;
  /** What the number measures. */
  readonly label: string;
  /** Whether the change is good, bad, or neither. */
  readonly trend: "down" | "neutral" | "up" | null;
  /** The number, already formatted. */
  readonly value: string;
}) {
  const TrendIcon = trend === "down" ? ArrowDownRightIcon : ArrowUpRightIcon;
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-2xl font-semibold tracking-tight">{value}</p>
      {change === null ? null : (
        <p
          className={cn(
            "flex items-center gap-1 text-xs",
            trend === "up" && "text-success",
            trend === "down" && "text-destructive",
            (trend === null || trend === "neutral") && "text-muted-foreground"
          )}
        >
          {trend === "up" || trend === "down" ? (
            <TrendIcon className="size-3.5" />
          ) : null}
          {change}
        </p>
      )}
    </div>
  );
}

/**
 * A slim progress bar with an optional label.
 *
 * @param props - The component props.
 * @returns The progress bar.
 */
function ProgressBar({
  label,
  max,
  value,
}: {
  /** Text shown above the bar. */
  readonly label: string | null;
  /** The value that counts as complete; defaults to 100. */
  readonly max: number | null;
  /** Progress so far. */
  readonly value: number;
}) {
  const total = max !== null && max > 0 ? max : 100;
  const percent = Math.min(100, Math.max(0, (value / total) * 100));
  return (
    <div className="space-y-2">
      {label === null ? null : (
        <p className="text-muted-foreground text-xs">{label}</p>
      )}
      <progress
        className="bg-muted [&::-moz-progress-bar]:bg-foreground/60 [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-foreground/60 block h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:rounded-full [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-value]:rounded-full"
        max={100}
        value={percent}
      />
    </div>
  );
}

/**
 * A text link that opens in a new tab.
 *
 * @param props - The component props.
 * @returns The link.
 */
function TextLink({
  href,
  label,
}: {
  /** The page to open. */
  readonly href: string;
  /** The link text. */
  readonly label: string;
}) {
  if (safeLinkUrl(href) === null) {
    return <span className="text-sm">{label}</span>;
  }
  return (
    <a
      className="text-primary text-sm font-medium underline-offset-4 hover:underline"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {label}
    </a>
  );
}

/**
 * An image with an optional caption, falling back to a placeholder when the
 * image fails to load.
 *
 * @param props - The component props.
 * @returns The figure.
 */
function CaptionedImage({
  alt,
  caption,
  src,
}: {
  /** What the image shows, for screen readers. */
  readonly alt: string;
  /** Text shown under the image. */
  readonly caption: string | null;
  /** The image URL. */
  readonly src: string;
}) {
  return (
    <figure className="space-y-2">
      <div className="overflow-hidden rounded-lg border">
        <CardImage alt={alt} src={src} />
      </div>
      {caption === null ? null : (
        <figcaption className="text-muted-foreground text-xs">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

/**
 * Label and value rows.
 *
 * @param props - The component props.
 * @returns The list.
 */
function KeyValueList({
  items,
}: {
  /** The rows to show. */
  readonly items: readonly { readonly label: string; readonly value: string }[];
}) {
  return (
    <dl className="divide-y rounded-lg border text-sm">
      {items.map(({ label, value }) => (
        <div className="flex gap-4 px-3 py-2" key={`${label}:${value}`}>
          <dt className="text-muted-foreground w-1/3 shrink-0">{label}</dt>
          <dd className="min-w-0 flex-1">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Numbered steps joined by a line, each with an optional detail and meta.
 *
 * @param props - The component props.
 * @returns The step list.
 */
function StepList({
  items,
}: {
  /** The steps, in order. */
  readonly items: readonly {
    readonly description: string | null;
    readonly meta: string | null;
    readonly title: string;
  }[];
}) {
  return (
    <ol className="space-y-0">
      {items.map((item, index) => (
        <li
          className="relative flex gap-3 pb-4 last:pb-0"
          key={`${item.title}:${item.meta ?? ""}:${item.description ?? ""}`}
        >
          {index < items.length - 1 ? (
            <span
              aria-hidden="true"
              className="bg-border absolute top-7 bottom-0 left-3 w-px"
            />
          ) : null}
          <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1 space-y-0.5 pt-0.5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-medium">{item.title}</p>
              {item.meta === null ? null : (
                <p className="text-muted-foreground shrink-0 text-xs">
                  {item.meta}
                </p>
              )}
            </div>
            {item.description === null ? null : (
              <p className="text-muted-foreground text-sm">
                {item.description}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

const HEADING_SIZES = {
  h1: "text-lg",
  h2: "text-base",
  h3: "text-sm",
  h4: "text-sm",
} as const;

const TEXT_STYLES = {
  body: "text-sm",
  caption: "text-muted-foreground text-xs",
  code: "font-mono text-sm",
  lead: "text-muted-foreground text-base",
  muted: "text-muted-foreground text-sm",
} as const;

/**
 * A heading sized for the chat rather than a full page.
 *
 * @param props - The component props.
 * @returns The heading.
 */
function ChatHeading({
  level,
  text,
}: {
  /** The heading level; defaults to `h2`. */
  readonly level: keyof typeof HEADING_SIZES | null;
  /** The heading text. */
  readonly text: string;
}) {
  const Tag = level ?? "h2";
  return (
    <Tag className={cn("font-semibold tracking-tight", HEADING_SIZES[Tag])}>
      {text}
    </Tag>
  );
}

/**
 * Body text sized for the chat rather than a full page.
 *
 * @param props - The component props.
 * @returns The paragraph.
 */
function ChatText({
  text,
  variant,
}: {
  /** The text to show. */
  readonly text: string;
  /** The text style; defaults to `body`. */
  readonly variant: keyof typeof TEXT_STYLES | null;
}) {
  return <p className={TEXT_STYLES[variant ?? "body"]}>{text}</p>;
}
