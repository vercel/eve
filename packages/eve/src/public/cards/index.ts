/**
 * Card builders and element types for content renderers. A renderer's `card` returns a
 * `CardElement`, which channels with rich messages post natively: Block Kit in Slack, and each
 * Chat SDK adapter's own format. These are pure data factories.
 *
 * Nothing on a card reaches the agent, so cards hold links but no action buttons or selects.
 */

export {
  Actions,
  Card,
  CardLink,
  CardText,
  Divider,
  Field,
  Fields,
  Image,
  LinkButton,
  Section,
  Table,
} from "#public/channels/slack/cards.js";

export type {
  ActionsElement,
  CardChild,
  CardElement,
  CardOptions,
  ChartDataPoint,
  ChartDefinition,
  ChartElement,
  ChartSegment,
  ChartSeries,
  DividerElement,
  FieldElement,
  FieldsElement,
  ImageElement,
  LinkButtonElement,
  LinkButtonOptions,
  LinkElement,
  PieChartDefinition,
  SectionElement,
  SeriesChartDefinition,
  TableAlignment,
  TableElement,
  TableOptions,
  TextElement,
  TextStyle,
} from "#public/channels/slack/cards.js";
