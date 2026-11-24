"use client";

import { Select } from "@base-ui/react/select";

import { DEVICES, type DeviceName } from "../../../agent/lib/devices";
import { Check, ChevronDown, Monitor } from "./icons";

const options = [
  { value: "browser", label: DEVICES.browser.label, description: "Chrome in the sandbox" },
  { value: "desktop", label: DEVICES.desktop.label, description: "Linux desktop with native apps" },
] as const;

function DeviceIcon({ device }: { readonly device: DeviceName }) {
  if (device === "desktop") return <Monitor size={16} />;
  return (
    <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 16 16" width="16">
      <rect
        x="1.75"
        y="2.75"
        width="12.5"
        height="10.5"
        rx="1.75"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M2 6h12" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function DevicePicker({
  disabled,
  onChange,
  value,
}: {
  readonly disabled: boolean;
  readonly onChange: (value: DeviceName) => void;
  readonly value: DeviceName;
}) {
  return (
    <span title={disabled ? "Start a new chat to use another device" : undefined}>
      <Select.Root<DeviceName>
        disabled={disabled}
        items={options}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
        value={value}
      >
        <Select.Trigger aria-label="Device" className="device-trigger">
          <DeviceIcon device={value} />
          <Select.Value />
          <Select.Icon className="device-chevron">
            <ChevronDown size={14} />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner
            align="end"
            alignItemWithTrigger={false}
            className="device-positioner"
            sideOffset={8}
          >
            <Select.Popup className="device-popup">
              <Select.List>
                {options.map((option) => (
                  <Select.Item
                    className="device-option"
                    key={option.value}
                    label={option.label}
                    value={option.value}
                  >
                    <DeviceIcon device={option.value} />
                    <div className="device-option-copy">
                      <Select.ItemText>{option.label}</Select.ItemText>
                      <span className="device-option-description">{option.description}</span>
                    </div>
                    <Select.ItemIndicator className="device-option-check">
                      <Check size={15} />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </span>
  );
}
