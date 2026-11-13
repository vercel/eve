import type { EveMessagePart } from "eve/react";
import {
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  ImageIcon,
} from "lucide-react";

type EveFilePart = Extract<EveMessagePart, { type: "file" }>;

/**
 * Renders an uploaded attachment with an image preview when available.
 * @param props - The message's file part.
 * @returns The attachment preview and download link.
 */
export function AttachmentPart({
  part,
}: {
  /** The file part. */
  readonly part: EveFilePart;
}) {
  const label = part.filename ?? "Attachment";
  const detail = [part.mediaType, formatBytes(part.size)]
    .filter(Boolean)
    .join(" - ");
  const isImage = part.mediaType.startsWith("image/") && part.url !== undefined;
  const Icon = isImage ? ImageIcon : FileIcon;
  const isDataUrl = part.url?.startsWith("data:") === true;
  const LinkIcon = isDataUrl ? DownloadIcon : ExternalLinkIcon;
  const body = (
    <span className="bg-background/60 flex max-w-sm items-center gap-3 rounded-md border p-2 text-sm">
      {isImage ? (
        <img
          alt={label}
          className="size-12 shrink-0 rounded-sm object-cover"
          src={part.url}
        />
      ) : (
        <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-sm">
          <Icon className="size-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {detail.length > 0 ? (
          <span className="text-muted-foreground block truncate">{detail}</span>
        ) : null}
      </span>
      {part.url === undefined ? null : (
        <LinkIcon className="text-muted-foreground size-4 shrink-0" />
      )}
    </span>
  );

  if (part.url === undefined) {
    return body;
  }
  return isDataUrl ? (
    <a download={part.filename ?? "attachment"} href={part.url}>
      {body}
    </a>
  ) : (
    <a href={part.url} rel="noreferrer" target="_blank">
      {body}
    </a>
  );
}

function formatBytes(size: number | undefined): string | undefined {
  if (size === undefined) {
    return undefined;
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
