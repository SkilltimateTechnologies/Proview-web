import { expect, test } from "bun:test";
import { pdfSafe } from "./student-report";

test("symbols the built-in PDF fonts cannot draw become readable text", () => {
  expect(pdfSafe("1 ≤ N ≤ 2 × 10^5")).toBe("1 <= N <= 2 × 10^5"); // × is in the font, kept
  expect(pdfSafe("a ≠ b, x → y, √2, − 1")).toBe("a != b, x -> y, sqrt2, - 1");
  expect(pdfSafe("Café — “quoted” …")).toBe("Café — “quoted” ...");
});

test("code and plain text pass through unchanged", () => {
  const code = "def main():\n\tprint('hi')  # ok\n";
  expect(pdfSafe(code)).toBe(code);
});

test("anything else outside the font prints as ? instead of a wrong glyph", () => {
  expect(pdfSafe("తెలుగు")).toBe("??????");
});
