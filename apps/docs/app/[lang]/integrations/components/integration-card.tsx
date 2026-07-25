import Link from "next/link";
import { type Integration, protocolBadgeClassName, protocolLabel } from "@/lib/integrations/data";
import { logos } from "@/lib/integrations/logos";

const typeLabel: Record<Integration["type"], string> = {
  channel: "Channel",
  connection: "Connection",
  extension: "Extension",
};

interface IntegrationCardProps {
  integration: Integration;
}

export const IntegrationCard = ({ integration }: IntegrationCardProps) => {
  const Logo = logos[integration.logo];

  return (
    <Link
      className="group flex flex-col gap-4 rounded-lg border bg-background-100 p-5 transition-colors hover:border-gray-400 hover:bg-gray-100"
      href={`/integrations/${integration.slug}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-background text-gray-1000">
          <Logo aria-hidden className="size-5" height={20} width={20} />
        </span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {integration.badge ? (
            <span className="rounded-full bg-teal-100 px-2 py-0.5 font-medium text-teal-900 text-xs">
              {integration.badge}
            </span>
          ) : null}
          {integration.protocols?.map((protocol) => (
            <span
              className={`rounded-full px-2 py-0.5 font-medium text-xs ${protocolBadgeClassName[protocol]}`}
              key={protocol}
            >
              {protocolLabel[protocol]}
            </span>
          ))}
          <span className="rounded-full border px-2.5 py-0.5 text-gray-900 text-xs">
            {typeLabel[integration.type]}
          </span>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="break-words font-medium text-base text-gray-1000 tracking-tight">
          {integration.name}
        </h3>
        <p className="break-words text-gray-900 text-sm leading-relaxed">{integration.tagline}</p>
      </div>
    </Link>
  );
};
