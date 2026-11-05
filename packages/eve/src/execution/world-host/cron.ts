// Whether a five-field cron expression (`minute hour day-of-month month day-of-week`, UTC) fires
// at a minute: `*`, numbers, `a-b` ranges, `/n` steps and `,` lists, as Vercel's cron reads them.
// Restricting both day fields fires on a day matching either, as cron does. Day-of-week 7 is
// Sunday, like 0.

const FIELDS = [
  { max: 59, min: 0 },
  { max: 23, min: 0 },
  { max: 31, min: 1 },
  { max: 12, min: 1 },
  { max: 7, min: 0 },
] as const;

interface ParsedCron {
  readonly sets: readonly ReadonlySet<number>[];
  /** Whether each day field is restricted (not `*`). */
  readonly restricted: readonly [boolean, boolean];
}

const parsed = new Map<string, ParsedCron>();

function parse(expression: string): ParsedCron {
  const cached = parsed.get(expression);
  if (cached !== undefined) return cached;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`"${expression}" isn't a five-field cron expression.`);
  const sets = fields.map((field, index) => {
    const { max, min } = FIELDS[index]!;
    const values = new Set<number>();
    for (const part of field.split(",")) {
      const [range, stepText] = part.split("/") as [string, string | undefined];
      const step = stepText === undefined ? 1 : Number(stepText);
      let [from, to] =
        range === "*" ? [min, max] : (range.split("-").map(Number) as [number, number?]);
      to ??= stepText === undefined ? from : max;
      if (
        ![from, to, step].every(Number.isInteger) ||
        step < 1 ||
        from < min ||
        to > max ||
        from > to
      )
        throw new Error(`"${expression}" has a field cron can't read: "${field}".`);
      for (let value = from; value <= to; value += step)
        values.add(index === 4 && value === 7 ? 0 : value);
    }
    return values;
  });
  const result: ParsedCron = {
    restricted: [fields[2] !== "*", fields[4] !== "*"],
    sets,
  };
  parsed.set(expression, result);
  return result;
}

/** Whether `expression` fires in the minute `at` falls in (UTC). */
export function cronFiresAt(expression: string, at: Date): boolean {
  const { restricted, sets } = parse(expression);
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = sets as [
    ReadonlySet<number>,
    ReadonlySet<number>,
    ReadonlySet<number>,
    ReadonlySet<number>,
    ReadonlySet<number>,
  ];
  if (!minutes.has(at.getUTCMinutes()) || !hours.has(at.getUTCHours())) return false;
  if (!months.has(at.getUTCMonth() + 1)) return false;
  const dayOfMonth = daysOfMonth.has(at.getUTCDate());
  const dayOfWeek = daysOfWeek.has(at.getUTCDay());
  return restricted[0] && restricted[1] ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek;
}
