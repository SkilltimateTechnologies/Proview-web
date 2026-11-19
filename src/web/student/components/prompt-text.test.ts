import { describe, expect, test } from "bun:test";
import { splitPrompt } from "./prompt-text";

describe("splitPrompt", () => {
  test("a plain prompt is one text part, newlines kept", () => {
    expect(splitPrompt("What is 2 + 2?")).toEqual([{ kind: "text", text: "What is 2 + 2?" }]);
    expect(splitPrompt("Line one\n\nLine two")).toEqual([{ kind: "text", text: "Line one\n\nLine two" }]);
  });

  test("empty and missing prompts give no parts", () => {
    expect(splitPrompt("")).toEqual([]);
    expect(splitPrompt(null)).toEqual([]);
    expect(splitPrompt(undefined)).toEqual([]);
  });

  test("fenced blocks become code parts with spacing kept exactly", () => {
    const p = "Sample input\n```\n5 7\n#P..#E#\n  x\n```\nSample output\n```\n8\n```";
    expect(splitPrompt(p)).toEqual([
      { kind: "text", text: "Sample input" },
      { kind: "code", text: "5 7\n#P..#E#\n  x" },
      { kind: "text", text: "Sample output" },
      { kind: "code", text: "8" },
    ]);
  });

  test("a language tag after the fence is accepted and Windows line endings are normalised", () => {
    expect(splitPrompt("Run:\r\n```python\r\nprint(1)\r\n```\r\n")).toEqual([
      { kind: "text", text: "Run:" },
      { kind: "code", text: "print(1)" },
    ]);
  });

  test("an unclosed fence runs to the end instead of losing text", () => {
    expect(splitPrompt("Input\n```\n1 2")).toEqual([
      { kind: "text", text: "Input" },
      { kind: "code", text: "1 2" },
    ]);
  });

  test("backticks inside a line are not a fence", () => {
    expect(splitPrompt("Use ```x``` here")).toEqual([{ kind: "text", text: "Use ```x``` here" }]);
  });
});
