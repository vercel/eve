import type { Integration } from "@/lib/integrations/data";
import { logos } from "@/lib/integrations/logos";

interface IntegrationLogoProps {
  integration: Pick<Integration, "logo" | "logoDomain">;
  className?: string;
  size: number;
}

/**
 * Curated entries render their hand-drawn brand SVG; generated entries render
 * the provider domain's favicon through the `/api/logo/[domain]` proxy.
 */
export const IntegrationLogo = ({ integration, className, size }: IntegrationLogoProps) => {
  if (integration.logoDomain) {
    return (
      <img
        alt=""
        className={className}
        height={size}
        loading="lazy"
        src={`/api/logo/${integration.logoDomain}`}
        width={size}
      />
    );
  }
  const Logo = logos[integration.logo];
  return <Logo aria-hidden className={className} height={size} width={size} />;
};
