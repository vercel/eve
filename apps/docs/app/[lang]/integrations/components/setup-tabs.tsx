"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import {
  type AuthMode,
  type ConnectionProtocol,
  authModeLabel,
  protocolLabel,
} from "@/lib/integrations/data";
import { setupKey } from "@/lib/integrations/connection-setup";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";

const PROTOCOL_PARAM = "protocol";
const AUTH_PARAM = "auth";

interface SetupTabsProps {
  protocols: ConnectionProtocol[];
  authModes: AuthMode[];
  variants: Record<string, string>;
}

const SwitcherRow = <T extends string>({
  options,
  active,
  label,
  onSelect,
}: {
  options: T[];
  active: T;
  label: (value: T) => string;
  onSelect: (value: T) => void;
}) => (
  <div className="inline-flex w-fit gap-0.5 rounded-md border bg-background-100 p-1">
    {options.map((option) => (
      <button
        className={cn(
          "rounded px-3 py-1 font-medium text-sm transition-colors",
          active === option
            ? "bg-gray-100 text-gray-1000"
            : "text-gray-900 hover:bg-gray-100/40 hover:text-gray-1000",
        )}
        key={option}
        onClick={() => onSelect(option)}
        type="button"
      >
        {label(option)}
      </button>
    ))}
  </div>
);

export const SetupTabs = ({ protocols, authModes, variants }: SetupTabsProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const fromUrl = <T extends string>(param: string, options: T[]): T => {
    const value = searchParams.get(param) as T | null;
    return value && options.includes(value) ? value : options[0];
  };

  const protocol = fromUrl(PROTOCOL_PARAM, protocols);
  const auth = fromUrl(AUTH_PARAM, authModes);
  const variantKey = setupKey(protocol, auth);
  const body = variants[variantKey];

  const setParam = useCallback(
    (param: string, value: string) => {
      const params = new URLSearchParams(searchParams);
      params.set(param, value);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  return (
    <div className="flex flex-col gap-4">
      {(protocols.length > 1 || authModes.length > 1) && (
        <div className="flex flex-wrap items-center gap-3">
          {protocols.length > 1 && (
            <SwitcherRow
              active={protocol}
              label={(value) => protocolLabel[value]}
              onSelect={(value) => setParam(PROTOCOL_PARAM, value)}
              options={protocols}
            />
          )}
          {authModes.length > 1 && (
            <SwitcherRow
              active={auth}
              label={(value) => authModeLabel[value]}
              onSelect={(value) => setParam(AUTH_PARAM, value)}
              options={authModes}
            />
          )}
        </div>
      )}
      {body ? <Markdown key={variantKey}>{body}</Markdown> : null}
    </div>
  );
};
