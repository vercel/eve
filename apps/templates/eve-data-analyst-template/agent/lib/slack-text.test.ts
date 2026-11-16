import { describe, expect, it } from "vitest";

import { escapeMrkdwn, escapeMrkdwnCode } from "./slack-text";

describe(escapeMrkdwn, () => {
  it("escapes ampersands before angle brackets", () => {
    expect(escapeMrkdwn("&lt; <!channel> a >= b & c")).toBe(
      "&amp;lt; &lt;!channel&gt; a &gt;= b &amp; c"
    );
  });

  it("leaves other characters alone", () => {
    const text = "SELECT `x`, *bold* _it_ ~s~ 'q' \"d\" ‹›";
    expect(escapeMrkdwn(text)).toBe(text);
  });
});

describe(escapeMrkdwnCode, () => {
  it("escapes control characters and breaks up runs of three or more backticks", () => {
    expect(escapeMrkdwnCode("a <b> `c` `` ``` ````")).toBe(
      "a &lt;b&gt; `c` `` `\u200B`\u200B` `\u200B`\u200B`\u200B`"
    );
  });
});
