"use client";

import { Radio, RadioGroup, RadioIndicator } from "@ui-sdk/react/radio";
import { CheckIcon, LaptopIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useId, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { PreferenceRow } from "../../_components/preference-row";

const subscribe = () => () => {};
const themes = [
  { value: "light", label: "Light", description: "Light background", Icon: SunIcon },
  { value: "dark", label: "Dark", description: "Dark background", Icon: MoonIcon },
  { value: "system", label: "System", description: "Match your device", Icon: LaptopIcon },
] as const;

export function ThemeSelect() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const id = useId();
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const selected = (mounted && themes.find(({ value }) => value === theme)) || themes[1];

  return (
    <>
      <PreferenceRow
        icon={PaletteIcon}
        title="Theme"
        detail={<span aria-live="polite">{selected.label} · This browser</span>}
        action={
          <Button
            aria-controls={open ? id : undefined}
            aria-expanded={open}
            aria-label={open ? "Done editing theme" : "Change theme"}
            disabled={!mounted}
            onClick={() => setOpen(!open)}
            size="lg"
            type="button"
            variant="ghost"
          >
            {open ? "Done" : "Change"}
          </Button>
        }
      />
      {open && (
        <RadioGroup
          aria-label="Theme for this browser"
          className="grid gap-2.5 border-t border-border py-4 sm:grid-cols-3"
          id={id}
          onValueChange={(value) => {
            if (value && themes.some((option) => option.value === value)) setTheme(value);
          }}
          value={selected.value}
        >
          {themes.map(({ value, label, description, Icon }) => (
            <Radio
              aria-label={label}
              className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border border-border px-3 py-3 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring data-checked:border-ring data-checked:bg-accent"
              key={value}
              value={value}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="type-label block">{label}</span>
                <span className="type-caption block text-muted-foreground">{description}</span>
              </span>
              <RadioIndicator className="shrink-0">
                <CheckIcon aria-hidden="true" className="size-4" />
              </RadioIndicator>
            </Radio>
          ))}
        </RadioGroup>
      )}
    </>
  );
}
