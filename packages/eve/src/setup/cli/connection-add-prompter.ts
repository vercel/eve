/** A selectable connection shown in the onboarding picker. */
export interface ConnectionSelectOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  disabledReason?: string;
}
