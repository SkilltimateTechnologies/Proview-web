/**
 * The student app names its icons by kebab-case string, and the icon map in
 * ui.tsx lists them explicitly (so the bundle stops carrying all ~1,600 lucide
 * icons). The risk of an explicit list is a silent miss: a new
 * `<Icon name="something" />` renders nothing. This test scans the student source
 * for every string literal that is a real lucide icon name and fails unless it is
 * in the map — or is on the short list of words that are lucide names but are
 * used here as something else (event types, CSS values, keywords).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as Lucide from "lucide-react";
import { STUDENT_ICONS } from "./ui";

const NOT_ICONS = new Set([
  "camera", "copy", "delete", "ellipsis", "filter", "focus", "grid", "import",
  "italic", "list", "map", "package", "pill", "pointer", "text",
]);

const root = join(import.meta.dir, "..");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const pascal = (n: string) => n.split("-").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
const isLucide = (n: string) => typeof (Lucide as Record<string, unknown>)[pascal(n)] === "object";

describe("student icon map", () => {
  test("every icon name used in the student app is in the map", () => {
    const missing = new Set<string>();
    for (const file of walk(root).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))) {
      for (const m of readFileSync(file, "utf8").matchAll(/["'`]([a-z][a-z0-9]*(?:-[a-z0-9]+)*)["'`]/g)) {
        const name = m[1];
        if (isLucide(name) && !NOT_ICONS.has(name) && !STUDENT_ICONS[name]) missing.add(`${name} (${file.slice(root.length + 1)})`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  test("every map entry is the matching lucide icon", () => {
    for (const [name, cmp] of Object.entries(STUDENT_ICONS)) {
      expect(cmp).toBe((Lucide as Record<string, unknown>)[pascal(name)] as typeof cmp);
    }
  });
});
