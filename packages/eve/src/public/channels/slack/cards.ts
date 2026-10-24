/** eve-owned Slack card data contracts. Chat SDK classes retain their identity at eve/channels/chat-sdk. */
import * as chat from "#compiled/chat/index.js";
declare const _Actions: ActionsComponent;
interface ActionsComponent {
  (
    children: (ButtonElement | LinkButtonElement | SelectElement | RadioSelectElement)[],
  ): ActionsElement;
  (props: ContainerProps): ChatElement;
}
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
type ButtonStyle = "primary" | "danger" | "default";
interface LinkButtonElement {
  id?: string;
  label: string;
  style?: ButtonStyle;
  tooltip?: string;
  type: "link-button";
  url: string;
  visibleTo?: string[];
}
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
interface SelectOptionElement {
  description?: string;
  label: string;
  value: string;
}
interface RadioSelectElement {
  dispatchAction?: boolean;
  id: string;
  initialOption?: string;
  label: string;
  optional?: boolean;
  options: SelectOptionElement[];
  type: "radio_select";
}
interface ActionsElement {
  children: (ButtonElement | LinkButtonElement | SelectElement | RadioSelectElement)[];
  type: "actions";
}
interface ContainerProps {
  children?: unknown;
}
type ChatElement =
  | CardJSXElement
  | CardElement
  | TextElement
  | ButtonElement
  | LinkButtonElement
  | LinkElement
  | ImageElement
  | DividerElement
  | ActionsElement
  | SectionElement
  | FieldsElement
  | FieldElement
  | ModalElement
  | TextInputElement
  | DateInputElement
  | NumberInputElement
  | SelectElement
  | ExternalSelectElement
  | SelectOptionElement
  | RadioSelectElement
  | TableElement
  | ChartElement;
interface CardJSXElement<P extends CardJSXProps = CardJSXProps> {
  $typeof: symbol;
  children: unknown[];
  props: P;
  type: CardComponentFunction;
}
type CardJSXProps =
  | CardProps
  | TextProps
  | ButtonProps
  | LinkButtonProps
  | CardLinkProps
  | ImageProps
  | FieldProps
  | ContainerProps
  | DividerProps
  | ModalProps
  | TextInputProps
  | DateInputProps
  | NumberInputProps
  | SelectProps
  | ExternalSelectProps
  | SelectOptionProps
  | TableProps
  | ChartProps;
interface CardProps {
  children?: unknown;
  imageUrl?: string;
  subtitle?: string;
  title?: string;
  width?: CardWidth;
}
type CardWidth = "default" | "full";
interface TextProps {
  children?: string | number | (string | number | undefined)[];
  style?: TextStyle;
}
type TextStyle = "plain" | "bold" | "muted";
interface ButtonProps {
  actionType?: "action" | "modal";
  callbackUrl?: string;
  children?: string | number | (string | number | undefined)[];
  disabled?: boolean;
  id: string;
  label?: string;
  style?: ButtonStyle;
  tooltip?: string;
  value?: string;
  visibleTo?: string[];
}
interface LinkButtonProps {
  children?: string | number | (string | number | undefined)[];
  id?: string;
  label?: string;
  style?: ButtonStyle;
  tooltip?: string;
  url: string;
  visibleTo?: string[];
}
interface CardLinkProps {
  children?: string | number | (string | number | undefined)[];
  label?: string;
  url: string;
}
interface ImageProps {
  alt?: string;
  url: string;
}
interface FieldProps {
  label: string;
  value: string;
}
type DividerProps = Record<string, never>;
interface ModalProps {
  callbackId: string;
  callbackUrl?: string;
  children?: unknown;
  closeLabel?: string;
  notifyOnClose?: boolean;
  privateMetadata?: string;
  submitLabel?: string;
  title: string;
}
interface TextInputProps {
  id: string;
  initialValue?: string;
  label: string;
  maxLength?: number;
  multiline?: boolean;
  optional?: boolean;
  placeholder?: string;
}
interface DateInputProps {
  id: string;
  initialValue?: string;
  label: string;
  optional?: boolean;
  placeholder?: string;
}
interface NumberInputProps {
  decimal?: boolean;
  id: string;
  initialValue?: number;
  label: string;
  max?: number;
  min?: number;
  optional?: boolean;
  placeholder?: string;
}
interface SelectProps {
  children?: unknown;
  dispatchAction?: boolean;
  id: string;
  initialOption?: string;
  label: string;
  optional?: boolean;
  placeholder?: string;
}
interface ExternalSelectProps {
  id: string;
  initialOption?: {
    label: string;
    value: string;
  };
  label: string;
  minQueryLength?: number;
  optional?: boolean;
  placeholder?: string;
}
interface SelectOptionProps {
  description?: string;
  label: string;
  value: string;
}
type TableProps = TableOptions;
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
type TableAlignment = "left" | "center" | "right";
type TableGridStyle = "default" | "emphasis" | "accent" | "good" | "attention" | "warning";
type TableVerticalAlignment = "top" | "center" | "bottom";
interface ChartProps {
  chart: ChartDefinition;
  title: string;
}
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
type CardComponentFunction =
  | typeof _Card
  | typeof Text
  | typeof _Button
  | typeof _LinkButton
  | typeof _CardLink
  | typeof _Image
  | typeof _Field
  | typeof _Divider
  | typeof _Section
  | typeof _ActionsInternal
  | typeof _Fields
  | typeof _Modal
  | typeof _TextInput
  | typeof DateInput
  | typeof NumberInput
  | typeof _Select
  | typeof _ExternalSelect
  | typeof _RadioSelect
  | typeof _SelectOption
  | typeof _Table
  | typeof Chart;
declare function _Card(options?: CardOptions): CardElement;
interface CardOptions {
  children?: CardChild[];
  imageUrl?: string;
  subtitle?: string;
  title?: string;
  width?: CardWidth;
}
type CardChild =
  | TextElement
  | ImageElement
  | DividerElement
  | ActionsElement
  | SectionElement
  | FieldsElement
  | LinkElement
  | TableElement
  | ChartElement
  | TextInputElement;
interface TextElement {
  content: string;
  style?: TextStyle;
  type: "text";
}
interface ImageElement {
  alt?: string;
  type: "image";
  url: string;
}
interface DividerElement {
  type: "divider";
}
interface SectionElement {
  children: CardChild[];
  type: "section";
}
interface FieldsElement {
  children: FieldElement[];
  type: "fields";
}
interface FieldElement {
  label: string;
  type: "field";
  value: string;
}
interface LinkElement {
  label: string;
  type: "link";
  url: string;
}
interface TableElement extends TableOptions {
  type: "table";
}
interface ChartElement {
  chart: ChartDefinition;
  title: string;
  type: "chart";
}
interface TextInputElement {
  id: string;
  initialValue?: string;
  label: string;
  maxLength?: number;
  multiline?: boolean;
  optional?: boolean;
  placeholder?: string;
  type: "text_input";
}
interface CardElement {
  children: CardChild[];
  imageUrl?: string;
  subtitle?: string;
  title?: string;
  type: "card";
  width?: CardWidth;
}
declare function Text(
  content: string,
  options?: {
    style?: TextStyle;
  },
): TextElement;
declare function _Button(options: ButtonOptions): ButtonElement;
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
declare function _LinkButton(options: LinkButtonOptions): LinkButtonElement;
interface LinkButtonOptions {
  id?: string;
  label: string;
  style?: ButtonStyle;
  tooltip?: string;
  url: string;
  visibleTo?: string[];
}
declare function _CardLink(options: { url: string; label: string }): LinkElement;
declare function _Image(options: { url: string; alt?: string }): ImageElement;
declare function _Field(options: { label: string; value: string }): FieldElement;
declare function _Divider(): DividerElement;
declare function _Section(children: CardChild[]): SectionElement;
declare function _ActionsInternal(
  children: (ButtonElement | LinkButtonElement | SelectElement | RadioSelectElement)[],
): ActionsElement;
declare function _Fields(children: FieldElement[]): FieldsElement;
declare function _Modal(options: ModalOptions): ModalElement;
interface ModalOptions {
  callbackId: string;
  callbackUrl?: string;
  children?: ModalChild[];
  closeLabel?: string;
  notifyOnClose?: boolean;
  privateMetadata?: string;
  submitLabel?: string;
  title: string;
}
type ModalChild =
  | TextInputElement
  | DateInputElement
  | NumberInputElement
  | SelectElement
  | ExternalSelectElement
  | RadioSelectElement
  | TextElement
  | FieldsElement;
interface DateInputElement {
  id: string;
  initialValue?: string;
  label: string;
  optional?: boolean;
  placeholder?: string;
  type: "date_input";
}
interface NumberInputElement {
  decimal?: boolean;
  id: string;
  initialValue?: number;
  label: string;
  max?: number;
  min?: number;
  optional?: boolean;
  placeholder?: string;
  type: "number_input";
}
interface ExternalSelectElement {
  id: string;
  initialOption?: SelectOptionElement;
  label: string;
  minQueryLength?: number;
  optional?: boolean;
  placeholder?: string;
  type: "external_select";
}
interface ModalElement {
  callbackId: string;
  callbackUrl?: string;
  children: ModalChild[];
  closeLabel?: string;
  notifyOnClose?: boolean;
  privateMetadata?: string;
  submitLabel?: string;
  title: string;
  type: "modal";
}
declare function _TextInput(options: TextInputOptions): TextInputElement;
interface TextInputOptions {
  id: string;
  initialValue?: string;
  label: string;
  maxLength?: number;
  multiline?: boolean;
  optional?: boolean;
  placeholder?: string;
}
declare function DateInput(options: DateInputOptions): DateInputElement;
interface DateInputOptions {
  id: string;
  initialValue?: string;
  label: string;
  optional?: boolean;
  placeholder?: string;
}
declare function NumberInput(options: NumberInputOptions): NumberInputElement;
interface NumberInputOptions {
  decimal?: boolean;
  id: string;
  initialValue?: number;
  label: string;
  max?: number;
  min?: number;
  optional?: boolean;
  placeholder?: string;
}
declare function _Select(options: SelectOptions): SelectElement;
interface SelectOptions {
  dispatchAction?: boolean;
  id: string;
  initialOption?: string;
  label: string;
  optional?: boolean;
  options: SelectOptionElement[];
  placeholder?: string;
}
declare function _ExternalSelect(options: ExternalSelectOptions): ExternalSelectElement;
interface ExternalSelectOptions {
  id: string;
  initialOption?: SelectOptionElement;
  label: string;
  minQueryLength?: number;
  optional?: boolean;
  placeholder?: string;
}
declare function _RadioSelect(options: RadioSelectOptions): RadioSelectElement;
interface RadioSelectOptions {
  dispatchAction?: boolean;
  id: string;
  initialOption?: string;
  label: string;
  optional?: boolean;
  options: SelectOptionElement[];
}
declare function _SelectOption(options: {
  label: string;
  value: string;
  description?: string;
}): SelectOptionElement;
declare function _Table(options: TableOptions): TableElement;
declare function Chart(options: ChartOptions): ChartElement;
interface ChartOptions {
  chart: ChartDefinition;
  title: string;
}
declare const _ButtonInternal: ButtonComponent;
interface ButtonComponent {
  (options: ButtonOptions): ButtonElement;
  (props: ButtonProps): ChatElement;
}
declare const _CardInternal: CardComponent;
interface CardComponent {
  (options?: CardOptions): CardElement;
  (props: CardProps): ChatElement;
}
declare const _CardLinkInternal: CardLinkComponent;
interface CardLinkComponent {
  (options: { url: string; label: string }): LinkElement;
  (props: CardLinkProps): ChatElement;
}
declare const _CardText: TextComponent;
interface TextComponent {
  (
    content: string,
    options?: {
      style?: TextStyle;
    },
  ): TextElement;
  (props: TextProps): ChatElement;
}
declare const _DividerInternal: DividerComponent;
interface DividerComponent {
  (): DividerElement;
  (props: DividerProps): ChatElement;
}
declare const _ExternalSelectInternal: ExternalSelectComponent;
interface ExternalSelectComponent {
  (options: ExternalSelectOptions): ExternalSelectElement;
  (props: ExternalSelectProps): ChatElement;
}
declare const _FieldInternal: FieldComponent;
interface FieldComponent {
  (options: { label: string; value: string }): FieldElement;
  (props: FieldProps): ChatElement;
}
declare const _FieldsInternal: FieldsComponent;
interface FieldsComponent {
  (children: FieldElement[]): FieldsElement;
  (props: ContainerProps): ChatElement;
}
declare const _ImageInternal: ImageComponent;
interface ImageComponent {
  (options: { url: string; alt?: string }): ImageElement;
  (props: ImageProps): ChatElement;
}
declare const _LinkButtonInternal: LinkButtonComponent;
interface LinkButtonComponent {
  (options: LinkButtonOptions): LinkButtonElement;
  (props: LinkButtonProps): ChatElement;
}
declare const _ModalInternal: ModalComponent;
interface ModalComponent {
  (options: ModalOptions): ModalElement;
  (props: ModalProps): ChatElement;
}
declare const _RadioSelectInternal: RadioSelectComponent;
interface RadioSelectComponent {
  (options: RadioSelectOptions): RadioSelectElement;
  (props: SelectProps): ChatElement;
}
declare const _SectionInternal: SectionComponent;
interface SectionComponent {
  (children: CardChild[]): SectionElement;
  (props: ContainerProps): ChatElement;
}
declare const _SelectInternal: SelectComponent;
interface SelectComponent {
  (options: SelectOptions): SelectElement;
  (props: SelectProps): ChatElement;
}
declare const _SelectOptionInternal: SelectOptionComponent;
interface SelectOptionComponent {
  (options: { label: string; value: string; description?: string }): SelectOptionElement;
  (props: SelectOptionProps): ChatElement;
}
declare const _TableInternal: typeof _Table;
declare const _TextInputInternal: TextInputComponent;
interface TextInputComponent {
  (options: TextInputOptions): TextInputElement;
  (props: TextInputProps): ChatElement;
}
declare const _cardChildToFallbackText: typeof _cardChildToFallbackTextInternal;
declare function _cardChildToFallbackTextInternal(child: CardChild): string | null;
declare const _isCardElement: typeof _isCardElementInternal;
declare function _isCardElementInternal(value: unknown): value is CardElement;
interface FileUpload {
  data: Buffer | Blob | ArrayBuffer;
  filename: string;
  mimeType?: string;
}
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
  ButtonProps,
  ButtonStyle,
  CardChild,
  CardElement,
  CardJSXElement,
  CardJSXProps,
  CardLinkProps,
  CardOptions,
  CardProps,
  ChatElement,
  ContainerProps,
  DividerElement,
  DividerProps,
  ExternalSelectElement,
  ExternalSelectOptions,
  ExternalSelectProps,
  FieldElement,
  FieldProps,
  FieldsElement,
  FileUpload,
  ImageElement,
  ImageProps,
  LinkButtonElement,
  LinkButtonOptions,
  LinkButtonProps,
  LinkElement,
  ModalChild,
  ModalElement,
  ModalOptions,
  ModalProps,
  PostableCard,
  RadioSelectElement,
  RadioSelectOptions,
  SectionElement,
  SelectElement,
  SelectOptionElement,
  SelectOptionProps,
  SelectOptions,
  SelectProps,
  TableAlignment,
  TableElement,
  TableOptions,
  TextElement,
  TextInputElement,
  TextInputOptions,
  TextInputProps,
  TextProps,
  TextStyle,
};
// JSX's SDK-private symbol is intentionally structural here; contract tests check copied data/props.
export const Actions: typeof _Actions = chat.Actions as typeof _Actions;
export const Button: typeof _ButtonInternal = chat.Button as typeof _ButtonInternal;
export const Card: typeof _CardInternal = chat.Card as typeof _CardInternal;
export const CardLink: typeof _CardLinkInternal = chat.CardLink as typeof _CardLinkInternal;
export const CardText: typeof _CardText = chat.CardText as typeof _CardText;
export const Divider: typeof _DividerInternal = chat.Divider;
export const ExternalSelect: typeof _ExternalSelectInternal = chat.ExternalSelect;
export const Field: typeof _FieldInternal = chat.Field;
export const Fields: typeof _FieldsInternal = chat.Fields as typeof _FieldsInternal;
export const Image: typeof _ImageInternal = chat.Image;
export const LinkButton: typeof _LinkButtonInternal = chat.LinkButton as typeof _LinkButtonInternal;
export const Modal: typeof _ModalInternal = chat.Modal as typeof _ModalInternal;
export const RadioSelect: typeof _RadioSelectInternal =
  chat.RadioSelect as typeof _RadioSelectInternal;
export const Section: typeof _SectionInternal = chat.Section as typeof _SectionInternal;
export const Select: typeof _SelectInternal = chat.Select as typeof _SelectInternal;
export const SelectOption: typeof _SelectOptionInternal = chat.SelectOption;
export const Table: typeof _TableInternal = chat.Table;
export const TextInput: typeof _TextInputInternal = chat.TextInput;
export const cardChildToFallbackText: typeof _cardChildToFallbackText =
  chat.cardChildToFallbackText;
export const isCardElement: typeof _isCardElement = chat.isCardElement;
