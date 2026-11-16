import type { EveMessagePart } from "eve/react";
import { ExternalLinkIcon, FileIcon, ImageIcon } from "lucide-react";
import { Button } from "@web/components/ui/button";
import { Card, CardContent } from "@web/components/ui/card";

type EveFilePart = Extract<EveMessagePart, { type: "file" }>;

export function AttachmentPart({ part }: { readonly part: EveFilePart }) {
  const label = part.filename ?? "Attachment";
  const detail = [part.mediaType, formatBytes(part.size)]
    .filter(Boolean)
    .join(" · ");
  const isImage = part.mediaType.startsWith("image/") && part.url !== undefined;
  const Icon = isImage ? ImageIcon : FileIcon;
  const content = (
    <>
      {isImage ? (
        // Browser artifacts use runtime URLs that cannot be declared in Next Image configuration.
        // oxlint-disable-next-line nextjs/no-img-element -- runtime browser artifact URL
        <img
          alt={label}
          className="size-12 shrink-0 rounded-sm object-cover"
          src={part.url}
        />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate type-label">{label}</span>
        {detail ? (
          <span className="block truncate text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      {part.url ? (
        <ExternalLinkIcon className="size-4 shrink-0 text-muted-foreground" />
      ) : null}
    </>
  );

  return part.url ? (
    <Button
      className="max-w-sm"
      nativeButton={false}
      render={
        <a
          aria-label={`Open ${label}`}
          href={part.url}
          rel="noreferrer"
          target="_blank"
        />
      }
      variant="surface"
    >
      {content}
    </Button>
  ) : (
    <Card className="max-w-sm" size="sm">
      <CardContent className="flex items-center gap-3">{content}</CardContent>
    </Card>
  );
}

function formatBytes(size: number | undefined): string | undefined {
  if (size === undefined) return undefined;
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
