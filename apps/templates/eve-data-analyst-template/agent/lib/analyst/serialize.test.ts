import { types } from "pg";
import { describe, expect, it } from "vitest";

import {
  columnTypeName,
  boundRows,
  toJsonCell,
  typeParsers,
} from "./serialize";

describe(toJsonCell, () => {
  it.each([
    [null, null],
    [true, true],
    [42, 42],
    [Number.NaN, "NaN"],
    [12_345_678_901_234_567_890n, "12345678901234567890"],
    [new Date("2026-09-01T00:00:00.000Z"), "2026-09-01T00:00:00.000Z"],
    [Buffer.from("abc"), "<3 bytes>"],
    [
      { plan: "pro", seats: 3 },
      { plan: "pro", seats: 3 },
    ],
    [
      ["a", "b"],
      ["a", "b"],
    ],
  ])("converts case %#", (value, expected) => {
    expect(toJsonCell(value, 500)).toStrictEqual(expected);
  });

  it("cuts long strings and objects with a marker", () => {
    expect(toJsonCell("x".repeat(12), 10)).toBe(
      `${"x".repeat(10)}… [truncated]`
    );
    expect(toJsonCell({ text: "x".repeat(20) }, 10)).toBe(
      '{"text":"x… [truncated]'
    );
  });
});

describe("typeParsers", () => {
  it.each([1082, 1083, 1114, 1184, 1186, 1266])(
    "keeps type %i as Postgres text",
    (oid) => {
      expect(typeParsers.getTypeParser(oid, "text")("2026-09-01")).toBe(
        "2026-09-01"
      );
    }
  );

  it("delegates other types to node-postgres", () => {
    expect(typeParsers.getTypeParser(23, "text")).toBe(
      types.getTypeParser(23, "text")
    );
  });
});

describe(columnTypeName, () => {
  it("names common and unknown types", () => {
    expect(columnTypeName(1700)).toBe("numeric");
    expect(columnTypeName(1184)).toBe("timestamptz");
    expect(columnTypeName(99_999)).toBe("oid:99999");
  });
});

describe(boundRows, () => {
  const limits = { maxCellChars: 500, maxOutputChars: 1000, maxRows: 3 };

  it("keeps rows within the limits", () => {
    expect(
      boundRows(
        [
          [1, "a"],
          [2, "b"],
        ],
        limits
      )
    ).toStrictEqual({
      rows: [
        [1, "a"],
        [2, "b"],
      ],
      truncated: false,
      truncatedReason: null,
    });
  });

  it("reports the row limit when an extra row was fetched", () => {
    expect(boundRows([[1], [2], [3], [4]], limits)).toStrictEqual({
      rows: [[1], [2], [3]],
      truncated: true,
      truncatedReason: "row-limit",
    });
  });

  it("drops whole rows that exceed the output budget", () => {
    const wide = [["x".repeat(400)], ["y".repeat(400)], ["z".repeat(400)]];
    const bounded = boundRows(wide, limits);
    expect(bounded.rows).toHaveLength(2);
    expect(bounded.truncatedReason).toBe("output-size");
  });

  it("always keeps the first row", () => {
    const bounded = boundRows([["x".repeat(400)]], {
      ...limits,
      maxOutputChars: 10,
    });
    expect(bounded.rows).toHaveLength(1);
  });
});
