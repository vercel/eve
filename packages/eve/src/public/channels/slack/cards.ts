import * as chat from "#compiled/chat/index.js";
declare const _Actions: ActionsComponent;
interface ActionsComponent {
  (
    children: (ButtonElement | LinkButtonElement | SelectElement | RadioSelectElement)[],
  ): ActionsElement;
}
/** Clickable button inside an {@link Actions} row, created with {@link Button}. */
interface ButtonElement {
  actionType?: "action" | "modal";
  callbackUrl?: string;
  disabled?: boolean;
  id: string;
  label: string;
  style?: ButtonStyle;
  tooltip?: string;
  type: "button";
  value?: string;
  visibleTo?: string[];
}
/** Visual style of a {@link Button} or {@link LinkButton}. */
type ButtonStyle = "primary" | "danger" | "default";
/** Button that opens a URL, created with {@link LinkButton}. */
interface LinkButtonElement {
  id?: string;
  label: string;
  style?: ButtonStyle;
  tooltip?: string;
  type: "link-button";
  url: string;
  visibleTo?: string[];
}
/** Dropdown menu of fixed choices, created with {@link Select}. */
interface SelectElement {
  dispatchAction?: boolean;
  id: string;
  initialOption?: string;
  label: string;
  optional?: boolean;
  options: SelectOptionElement[];
  placeholder?: string;
  type: "select";
}
/** One choice in a {@link Select} or {@link RadioSelect}, created with {@link SelectOption}. */
interface SelectOptionElement {
  description?: string;
  label: string;
  value: string;
}
/** Radio button group of fixed choices, created with {@link RadioSelect}. */
interface RadioSelectElement {
  dispatchAction?: boolean;
  id: string;
  initialOption?: string;
  label: string;
  optional?: boolean;
  options: SelectOptionElement[];
  type: "radio_select";
}
/** Row of buttons and select controls, created with {@link Actions}. */
interface ActionsElement {
  children: (ButtonElement | LinkButtonElement | SelectElement | RadioSelectElement)[];
  type: "actions";
}
type CardWidth = "default" | "full";
/** Display style of a {@link CardText} block. */
type TextStyle = "plain" | "bold" | "muted";
/**
 * Options for {@link Table}: column headers, rows of cell text, and optional layout settings.
 */
interface TableOptions {
  align?: TableAlignment[];
  caption?: string;
  gridLines?: boolean;
  gridStyle?: TableGridStyle;
  headers: string[];
  pageSize?: number;
  rows: string[][];
  verticalAlign?: TableVerticalAlignment;
  widths?: number[];
}
/** Horizontal alignment of a {@link Table} column. */
type TableAlignment = "left" | "center" | "right";
type TableGridStyle = "default" | "emphasis" | "accent" | "good" | "attention" | "warning";
type TableVerticalAlignment = "top" | "center" | "bottom";
type ChartDefinition = PieChartDefinition | SeriesChartDefinition;
interface PieChartDefinition {
  segments: ChartSegment[];
  type: "pie";
}
interface ChartSegment {
  label: string;
  value: number;
}
interface SeriesChartDefinition {
  categories: string[];
  series: ChartSeries[];
  type: "area" | "bar" | "line";
  xLabel?: string;
  yLabel?: string;
}
interface ChartSeries {
  data: ChartDataPoint[];
  name: string;
}
interface ChartDataPoint {
  label: string;
  value: number;
}
/**
 * Options for {@link Card}: an optional title, subtitle, header image, width, and child elements.
 */
interface CardOptions {
  children?: CardChild[];
  imageUrl?: string;
  subtitle?: string;
  title?: string;
  width?: CardWidth;
}
/** Any element that can appear inside a {@link Card} or {@link Section}. */
type CardChild =
  | TextElement
  | ImageElement
  | DividerElement
  | ActionsElement
  | SectionElement
  | FieldsElement
  | LinkElement
  | TableElement
  | ChartElement;
/** Block of Slack mrkdwn text, created with {@link CardText}. */
interface TextElement {
  content: string;
  style?: TextStyle;
  type: "text";
}
/** Image shown in a card, created with {@link Image}. */
interface ImageElement {
  alt?: string;
  type: "image";
  url: string;
}
/** Horizontal rule between card elements, created with {@link Divider}. */
interface DividerElement {
  type: "divider";
}
/** Group of card elements, created with {@link Section}. */
interface SectionElement {
  children: CardChild[];
  type: "section";
}
/** Group of labeled values, created with {@link Fields}. */
interface FieldsElement {
  children: FieldElement[];
  type: "fields";
}
/** One labeled value inside {@link Fields}, created with {@link Field}. */
interface FieldElement {
  label: string;
  type: "field";
  value: string;
}
/** Inline link in a card, created with {@link CardLink}. */
interface LinkElement {
  label: string;
  type: "link";
  url: string;
}
/** Table of rows and columns, created with {@link Table}. */
interface TableElement extends TableOptions {
  type: "table";
}
interface ChartElement {
  chart: ChartDefinition;
  title: string;
  type: "chart";
}
/** Root card layout, created with {@link Card} and posted with `thread.post({ card })`. */
interface CardElement {
  children: CardChild[];
  imageUrl?: string;
  subtitle?: string;
  title?: string;
  type: "card";
  width?: CardWidth;
}
/**
 * Options for {@link Button}. `id` identifies the button in `onInteraction`, and `value` is passed back
 * when it is clicked.
 */
interface ButtonOptions {
  actionType?: "action" | "modal";
  callbackUrl?: string;
  disabled?: boolean;
  id: string;
  label: string;
  style?: ButtonStyle;
  tooltip?: string;
  value?: string;
  visibleTo?: string[];
}
/** Options for {@link LinkButton}: the label and the URL to open. */
interface LinkButtonOptions {
  id?: string;
  label: string;
  style?: ButtonStyle;
  tooltip?: string;
  url: string;
  visibleTo?: string[];
}
/** Options for {@link Select}. `id` identifies the control in `onInteraction`. */
interface SelectOptions {
  dispatchAction?: boolean;
  id: string;
  initialOption?: string;
  label: string;
  optional?: boolean;
  options: SelectOptionElement[];
  placeholder?: string;
}
/** Options for {@link RadioSelect}. `id` identifies the control in `onInteraction`. */
interface RadioSelectOptions {
  dispatchAction?: boolean;
  id: string;
  initialOption?: string;
  label: string;
  optional?: boolean;
  options: SelectOptionElement[];
}
declare function _Table(options: TableOptions): TableElement;
declare const _ButtonInternal: ButtonComponent;
interface ButtonComponent {
  (options: ButtonOptions): ButtonElement;
}
declare const _CardInternal: CardComponent;
interface CardComponent {
  (options?: CardOptions): CardElement;
}
declare const _CardLinkInternal: CardLinkComponent;
interface CardLinkComponent {
  (options: { url: string; label: string }): LinkElement;
}
declare const _CardText: TextComponent;
interface TextComponent {
  (
    content: string,
    options?: {
      style?: TextStyle;
    },
  ): TextElement;
}
declare const _DividerInternal: DividerComponent;
interface DividerComponent {
  (): DividerElement;
}
declare const _FieldInternal: FieldComponent;
interface FieldComponent {
  (options: { label: string; value: string }): FieldElement;
}
declare const _FieldsInternal: FieldsComponent;
interface FieldsComponent {
  (children: FieldElement[]): FieldsElement;
}
declare const _ImageInternal: ImageComponent;
interface ImageComponent {
  (options: { url: string; alt?: string }): ImageElement;
}
declare const _LinkButtonInternal: LinkButtonComponent;
interface LinkButtonComponent {
  (options: LinkButtonOptions): LinkButtonElement;
}
declare const _RadioSelectInternal: RadioSelectComponent;
interface RadioSelectComponent {
  (options: RadioSelectOptions): RadioSelectElement;
}
declare const _SectionInternal: SectionComponent;
interface SectionComponent {
  (children: CardChild[]): SectionElement;
}
declare const _SelectInternal: SelectComponent;
interface SelectComponent {
  (options: SelectOptions): SelectElement;
}
declare const _SelectOptionInternal: SelectOptionComponent;
interface SelectOptionComponent {
  (options: { label: string; value: string; description?: string }): SelectOptionElement;
}
declare const _TableInternal: typeof _Table;
/** File to attach to a posted card. */
interface FileUpload {
  data: Buffer | Blob | ArrayBuffer;
  filename: string;
  mimeType?: string;
}
/**
 * Message that posts a card with `thread.post`. When `fallbackText` is omitted, eve derives the
 * notification text from the card.
 */
interface PostableCard {
  aiGenerated?: boolean;
  card: CardElement;
  fallbackText?: string;
  files?: FileUpload[];
}

export type {
  ActionsElement,
  ButtonElement,
  ButtonOptions,
  ButtonStyle,
  CardChild,
  CardElement,
  CardOptions,
  DividerElement,
  FieldElement,
  FieldsElement,
  FileUpload,
  ImageElement,
  LinkButtonElement,
  LinkButtonOptions,
  LinkElement,
  PostableCard,
  RadioSelectElement,
  RadioSelectOptions,
  SectionElement,
  SelectElement,
  SelectOptionElement,
  SelectOptions,
  TableAlignment,
  TableElement,
  TableOptions,
  TextElement,
  TextStyle,
};
/** Groups buttons, link buttons, and select controls into one row of a card. */
export const Actions: typeof _Actions = chat.Actions as typeof _Actions;
/** Creates a button whose clicks reach your channel's `onInteraction` handler. */
export const Button: typeof _ButtonInternal = chat.Button as typeof _ButtonInternal;
/** Creates a card, the root layout for a rich Slack message built from typed elements. */
export const Card: typeof _CardInternal = chat.Card as typeof _CardInternal;
/** Creates a link with a label for use inside a card. */
export const CardLink: typeof _CardLinkInternal = chat.CardLink as typeof _CardLinkInternal;
/** Creates a block of Slack mrkdwn text, optionally styled bold or muted. */
export const CardText: typeof _CardText = chat.CardText as typeof _CardText;
/** Creates a horizontal rule between card elements. */
export const Divider: typeof _DividerInternal = chat.Divider;
/** Creates one labeled value for {@link Fields}. */
export const Field: typeof _FieldInternal = chat.Field;
/** Groups {@link Field} values into a compact labeled list. */
export const Fields: typeof _FieldsInternal = chat.Fields as typeof _FieldsInternal;
/** Creates an image element from a URL with optional alt text. */
export const Image: typeof _ImageInternal = chat.Image;
/** Creates a button that opens a URL. */
export const LinkButton: typeof _LinkButtonInternal = chat.LinkButton as typeof _LinkButtonInternal;
/** Creates a radio button group of fixed choices for use inside {@link Actions}. */
export const RadioSelect: typeof _RadioSelectInternal =
  chat.RadioSelect as typeof _RadioSelectInternal;
/** Groups card elements together. */
export const Section: typeof _SectionInternal = chat.Section as typeof _SectionInternal;
/** Creates a dropdown menu of fixed choices for use inside {@link Actions}. */
export const Select: typeof _SelectInternal = chat.Select as typeof _SelectInternal;
/** Creates one choice for {@link Select} or {@link RadioSelect}. */
export const SelectOption: typeof _SelectOptionInternal = chat.SelectOption;
/** Creates a table from column headers and rows of cell text. */
export const Table: typeof _TableInternal = chat.Table;
