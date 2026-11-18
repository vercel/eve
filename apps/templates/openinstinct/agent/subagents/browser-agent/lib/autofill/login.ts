import type { AutofillClaim } from "./protocol";

export const nativeLoginAutofillTokens = [
  "username",
  "email",
  "tel",
  "current-password",
] as const;

export interface NativeLoginControlDescriptor {
  readonly autocomplete: string;
  readonly focused: boolean;
  readonly formIndex: number | null;
  readonly index: number;
  readonly label: string;
  readonly name: string;
  readonly type: string;
}

export interface ClassifiedNativeLoginControl extends NativeLoginControlDescriptor {
  readonly score: number;
  readonly token: (typeof nativeLoginAutofillTokens)[number];
}

export function classifyNativeLoginControl(
  descriptor: NativeLoginControlDescriptor
): ClassifiedNativeLoginControl | null {
  const autocompleteTokens = descriptor.autocomplete
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  if (
    autocompleteTokens.some((token) =>
      ["new-password", "one-time-code"].includes(token)
    )
  ) {
    return null;
  }

  for (const token of nativeLoginAutofillTokens) {
    if (autocompleteTokens.includes(token)) {
      return { ...descriptor, score: 100, token };
    }
  }

  const searchable = normalizeText(
    [descriptor.name, descriptor.label].filter(Boolean).join(" ")
  );
  if (/\b(?:new|confirm|create|repeat)\s*password\b/u.test(searchable)) {
    return null;
  }
  if (descriptor.type === "password") {
    return { ...descriptor, score: 90, token: "current-password" };
  }
  if (descriptor.type === "email") {
    return { ...descriptor, score: 85, token: "email" };
  }
  if (descriptor.type === "tel") {
    return { ...descriptor, score: 85, token: "tel" };
  }
  if (/\b(?:e-?mail|email address)\b/u.test(searchable)) {
    return { ...descriptor, score: 75, token: "email" };
  }
  if (/\b(?:phone|telephone|mobile)\b/u.test(searchable)) {
    return { ...descriptor, score: 75, token: "tel" };
  }
  if (
    /\b(?:user\s*name|username|login|account|member|membership|mileageplus)\b/u.test(
      searchable
    )
  ) {
    return { ...descriptor, score: 70, token: "username" };
  }
  return null;
}

export function selectNativeLoginFills<T extends ClassifiedNativeLoginControl>(
  controls: readonly T[],
  claims: readonly Pick<AutofillClaim, "token" | "value">[]
) {
  const focused = controls.find((control) => control.focused);
  if (!focused) return [];

  const sameSurface = controls
    .filter((control) => control.formIndex === focused.formIndex)
    .toSorted(compareLoginControls);
  const values = new Map(claims.map(({ token, value }) => [token, value]));
  const selected: { readonly control: T; readonly value: string }[] = [];

  const identifier = sameSurface.find(
    (control) =>
      control.token !== "current-password" &&
      (values.has(control.token) || values.has("username"))
  );
  if (identifier) {
    const value = values.get(identifier.token) ?? values.get("username");
    if (value !== undefined) selected.push({ control: identifier, value });
  }

  const password = sameSurface.find(
    (control) =>
      control.token === "current-password" && values.has(control.token)
  );
  if (password) {
    const value = values.get(password.token);
    if (value !== undefined) selected.push({ control: password, value });
  }
  return selected;
}

export const nativeLoginControlInspectionExpression = `(() => {
  const elements = Array.from(document.querySelectorAll("input"));
  const forms = Array.from(document.forms);
  return elements.flatMap((element, index) => {
    if (element.disabled || element.readOnly) return [];
    if (["hidden", "submit", "button", "reset", "file", "image", "checkbox", "radio"].includes(element.type)) return [];
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) return [];
    const labels = element.labels ? Array.from(element.labels, (label) => label.textContent || "") : [];
    const ariaText = (element.getAttribute("aria-labelledby") || "")
      .split(/\\s+/u)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ");
    const resolvedFormIndex = element.form ? forms.indexOf(element.form) : -1;
    return [{
      autocomplete: element.autocomplete || "",
      focused: document.activeElement === element,
      formIndex: resolvedFormIndex >= 0 ? resolvedFormIndex : null,
      index,
      label: [
        ...labels,
        element.getAttribute("aria-label") || "",
        ariaText,
        element.getAttribute("placeholder") || "",
        element.getAttribute("title") || "",
      ].join(" "),
      name: [element.name, element.id].join(" "),
      type: element.type || "",
    }];
  });
})()`;

// Evaluated inside a frame's isolated world. `self.origin` is the origin of the
// document that would receive a value, so it also rejects sandboxed documents.
export const frameOriginExpression = "self.origin";

export const nativeLoginFillFunctionDeclaration = `function(value, expectedOrigin) {
  if (self.origin !== expectedOrigin) return false;
  if (!(this instanceof HTMLInputElement)) return false;
  this.dataset.vaultSecret = "true";
  this.click();
  this.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return false;
  setter.call(this, value);
  this.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return this.value.length > 0;
}`;

function compareLoginControls(
  left: ClassifiedNativeLoginControl,
  right: ClassifiedNativeLoginControl
) {
  if (left.focused !== right.focused) return left.focused ? -1 : 1;
  if (left.score !== right.score) return right.score - left.score;
  return left.index - right.index;
}

function normalizeText(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();
}
