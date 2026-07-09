import Link from "next/link";
import {
  type GalleryIntegration,
  protocolBadgeClassName,
  protocolLabel,
} from "@/lib/integrations/data";
import { IntegrationLogo } from "./integration-logo";

interface IntegrationCardProps {
  integration: GalleryIntegration;
}

const providerLabel = (integration: GalleryIntegration): string | null => {
  if (integration.logoDomain) {
    return integration.logoDomain;
  }
  const endpoint = integration.surfaces?.[0]?.endpointValue;
  if (!endpoint) return null;
  try {
    return new URL(endpoint).hostname;
  } catch {
    return null;
  }
};

export const IntegrationCard = ({ integration }: IntegrationCardProps) => {
  const provider = providerLabel(integration);
  const surfaces = integration.surfaces ?? [];
  const protocols = [...new Set(surfaces.map((surface) => surface.protocol))];
  const authLabel = integration.type === "channel" ? null : surfaces[0]?.authLabels[0];

  return (
    <Link
      className="group flex min-h-44 min-w-0 flex-col gap-4 rounded-lg border bg-background-100 p-5 transition-colors [contain-intrinsic-size:176px] [content-visibility:auto] hover:border-gray-400 hover:bg-gray-100"
      href={`/integrations/${integration.slug}`}
    >
      <div className="flex items-center justify-between">
        <span className="flex size-10 items-center justify-center rounded-md border bg-background text-gray-1000">
          <IntegrationLogo className="size-5" integration={integration} size={20} />
        </span>
        <div className="flex items-center gap-1.5">
          {integration.type === "channel" ? (
            <span className="rounded-full border bg-background px-2 py-0.5 font-medium text-gray-900 text-xs">
              Channel
            </span>
          ) : (
            protocols.map((protocol) => (
              <span
                className={`rounded-full px-2 py-0.5 font-medium text-xs ${protocolBadgeClassName[protocol]}`}
                key={protocol}
              >
                {protocolLabel[protocol]}
              </span>
            ))
          )}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <h3 className="break-words font-medium text-base text-gray-1000 tracking-tight">
          {integration.name}
        </h3>
        {provider ? <p className="truncate text-gray-800 text-xs">{provider}</p> : null}
        <p className="overflow-hidden break-words text-gray-900 text-sm leading-relaxed [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
          {integration.tagline}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {integration.source !== "generated" ? (
          <span className="rounded-full border px-2 py-0.5 text-gray-900 text-xs">Curated</span>
        ) : null}
        {authLabel ? (
          <span className="rounded-full border px-2 py-0.5 text-gray-900 text-xs">{authLabel}</span>
        ) : null}
      </div>
    </Link>
  );
};
