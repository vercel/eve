import Link from "next/link";
import { type Integration, protocolBadgeClassName, protocolLabel } from "@/lib/integrations/data";
import { logos } from "@/lib/integrations/logos";

const typeLabel: Record<Integration["type"], string> = {
  channel: "Channel",
  connection: "Connection",
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
      <div className="flex items-center justify-between">
        <span className="flex size-10 items-center justify-center rounded-md border bg-background text-gray-1000">
          <Logo aria-hidden className="size-5" height={20} width={20} />
        </span>
        <div className="flex items-center gap-1.5">
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
      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-base text-gray-1000 tracking-tight">{integration.name}</h3>
        <p className="text-gray-900 text-sm leading-relaxed">{integration.tagline}</p>
      </div>
    </Link>
  );
};
