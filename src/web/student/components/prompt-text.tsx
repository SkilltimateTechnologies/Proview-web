/**
 * Question text with its line breaks kept.
 *
 * A prompt used to be dropped into a single <div>, so the browser folded every
 * newline into a space: a coding problem with "Input format", "Constraints" and a
 * sample grid arrived as one run-on paragraph. Now plain text keeps its lines, and
 * anything between lines of three backticks is shown as a monospace block, so
 * sample input and output (and grids like "#P..#E#") line up exactly as written.
 *
 * Prompts without backticks render as before apart from keeping their newlines.
 */
import type { CSSProperties } from "react";

export type PromptPart = { kind: "text" | "code"; text: string };

const FENCE = /^\s*```[\w-]*\s*$/;

/** Split a prompt into plain-text and ``` fenced parts. An unclosed fence runs to the end. */
export function splitPrompt(prompt: string | null | undefined): PromptPart[] {
  const lines = String(prompt ?? "").replace(/\r\n?/g, "\n").split("\n");
  const parts: PromptPart[] = [];
  let buf: string[] = [];
  let inCode = false;
  const flush = () => {
    const text = inCode ? buf.join("\n") : buf.join("\n").replace(/^\n+|\n+$/g, "");
    if (text.length || inCode) parts.push({ kind: inCode ? "code" : "text", text });
    buf = [];
  };
  for (const line of lines) {
    if (FENCE.test(line)) {
      flush();
      inCode = !inCode;
    } else {
      buf.push(line);
    }
  }
  if (inCode || buf.length) flush();
  return parts.filter((p) => p.kind === "code" || p.text.trim().length > 0);
}

const codeStyle: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace)",
  fontSize: "0.92em",
  fontWeight: 400,
  lineHeight: 1.5,
  whiteSpace: "pre",
  overflowX: "auto",
  background: "rgba(127,127,127,.10)",
  border: "1px solid rgba(127,127,127,.22)",
  borderRadius: 8,
  padding: "8px 12px",
  margin: "6px 0 10px",
};

export function PromptText({ text, className, style }: { text: string | null | undefined; className?: string; style?: CSSProperties }) {
  const parts = splitPrompt(text);
  return (
    <div className={className} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", ...style }}>
      {parts.map((p, i) =>
        p.kind === "code" ? (
          <pre key={i} style={codeStyle}>{p.text}</pre>
        ) : (
          <div key={i}>{p.text}</div>
        ),
      )}
    </div>
  );
}
