import { type GlyphFieldOptions, glyphCell, glyphMarks, glyphSymbols } from "./glyphs";

export function GlyphField({
  className,
  fit = "slice",
  ...options
}: GlyphFieldOptions & { className?: string; fit?: "slice" | "meet" }) {
  const prefix = `challenge-glyph-${options.seed}`;
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-glyph-field=""
      fill="none"
      preserveAspectRatio={`xMidYMid ${fit}`}
      viewBox={`0 0 ${options.columns * glyphCell} ${options.rows * glyphCell}`}
    >
      <defs>
        {glyphSymbols.map(({ path, stroke }, index) => (
          <path
            d={path}
            fill={stroke ? "none" : "currentColor"}
            id={`${prefix}-${index}`}
            key={path}
            stroke={stroke ? "currentColor" : undefined}
            strokeWidth={stroke}
            transform="scale(1.4)"
          />
        ))}
      </defs>
      {glyphMarks(options).map(({ id, x, y, symbol, opacity }) => (
        <use href={`#${prefix}-${symbol}`} key={id} opacity={opacity} x={x} y={y} />
      ))}
    </svg>
  );
}
