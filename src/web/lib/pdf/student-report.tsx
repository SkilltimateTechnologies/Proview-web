// Per-student answer sheet PDF: branded header, score summary, then every question
// with the student's answer, the correct answer (objective), AI feedback and the
// explanation. Handed to students. Exported as a Blob via generateStudentReport().
import type { ReactElement } from "react";
import { Document, Page, View, Text, Image, StyleSheet, pdf } from "@react-pdf/renderer";
import { C, type Brand, fmtDate } from "./theme";

export type StudentAnswer = {
  id: string;
  prompt: string;
  type: string;
  topic: string | null;
  options: unknown;
  correct: unknown;
  explanation: string | null;
  response: unknown;
  score: number | null;
  maxScore: number | null;
  aiNotes: string | null;
};

export type StudentReportData = {
  brand: Brand;
  examTitle: string;
  student: { name: string; rollNo: string; email: string | null; section?: string };
  attempt: { score: number | null; status: string; submittedAt: string | number | null };
  totalQuestions?: number;
  answers: StudentAnswer[];
};

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

const s = StyleSheet.create({
  page: { paddingTop: 28, paddingBottom: 44, paddingHorizontal: 34, fontFamily: "Helvetica", color: C.ink },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  logo: { height: 26, objectFit: "contain" },
  college: { fontSize: 10, color: C.ink2, fontFamily: "Helvetica-Bold", maxWidth: 260, textAlign: "right" },
  accentBar: { height: 3, borderRadius: 2, marginTop: 8, marginBottom: 14 },
  title: { fontSize: 16, fontFamily: "Helvetica-Bold", color: C.ink, lineHeight: 1.3 },
  sub: { fontSize: 9, color: C.ink2, marginTop: 2, lineHeight: 1.3 },

  infoCard: { flexDirection: "row", justifyContent: "space-between", borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 14, marginTop: 14, backgroundColor: C.soft },
  infoLeft: { flex: 1, paddingRight: 12 },
  infoName: { fontSize: 13, fontFamily: "Helvetica-Bold", color: C.ink, lineHeight: 1.3 },
  infoMeta: { fontSize: 8.5, color: C.ink2, marginTop: 3, lineHeight: 1.3 },
  scoreBox: { alignItems: "flex-end", width: 110 },
  scoreNum: { fontSize: 24, fontFamily: "Helvetica-Bold", lineHeight: 1.15 },
  scoreLbl: { fontSize: 7, letterSpacing: 0.6, color: C.muted, textTransform: "uppercase", marginTop: 2 },

  sectionLabel: { fontSize: 8, letterSpacing: 1, color: C.muted, fontFamily: "Helvetica-Bold", textTransform: "uppercase", marginTop: 18, marginBottom: 8 },

  qCard: { borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 },
  qHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6, paddingBottom: 6, borderBottomWidth: 0.5, borderBottomColor: C.line },
  qTitle: { fontSize: 10.5, fontFamily: "Helvetica-Bold", color: C.ink, lineHeight: 1.35 },
  qType: { fontSize: 6.5, letterSpacing: 0.5, color: C.muted, textTransform: "uppercase", marginTop: 2 },
  qPts: { fontSize: 9.5, fontFamily: "Helvetica-Bold", marginLeft: 10 },

  para: { fontSize: 9, color: C.ink, lineHeight: 1.45, marginBottom: 5 },
  heading: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: C.ink, marginTop: 4, marginBottom: 2, lineHeight: 1.3 },
  inlineCode: { fontFamily: "Courier", fontSize: 8.5 },
  sampleBox: { backgroundColor: "#F3F5F8", borderWidth: 0.5, borderColor: C.line, borderRadius: 6, paddingVertical: 6, paddingHorizontal: 8, marginBottom: 6 },
  sampleLine: { fontFamily: "Courier", fontSize: 8.5, color: C.ink, lineHeight: 1.35 },

  opt: { flexDirection: "row", alignItems: "flex-start", gap: 7, borderWidth: 1, borderColor: C.line, borderRadius: 7, paddingVertical: 6, paddingHorizontal: 8, marginTop: 4, backgroundColor: C.white },
  optLetter: { width: 15, height: 15, borderRadius: 4, backgroundColor: "#EEF1F5", color: C.ink2, fontSize: 8, fontFamily: "Helvetica-Bold", textAlign: "center", paddingTop: 2.5 },
  optTxt: { fontSize: 9, color: C.ink, flex: 1 },
  tag: { fontSize: 6.5, fontFamily: "Helvetica-Bold", paddingHorizontal: 4, paddingVertical: 1.5, borderRadius: 3 },

  answerBlock: { marginTop: 6 },
  blockLbl: { fontSize: 7, letterSpacing: 0.5, color: C.muted, textTransform: "uppercase", marginBottom: 3, fontFamily: "Helvetica-Bold" },
  codeBox: { backgroundColor: "#0F1B2B", paddingVertical: 8, paddingHorizontal: 9, borderRadius: 7 },
  codeRow: { flexDirection: "row" },
  codeNo: { width: 20, fontFamily: "Courier", fontSize: 7.5, color: "#6B7A90", lineHeight: 1.45, textAlign: "right", marginRight: 8 },
  codeLine: { flex: 1, fontFamily: "Courier", fontSize: 8.5, color: "#E6EDF5", lineHeight: 1.45 },
  textBox: { fontSize: 9, backgroundColor: "#F6F7F9", color: C.ink, padding: 9, borderRadius: 7, borderWidth: 0.5, borderColor: C.line, lineHeight: 1.5 },
  noAns: { fontSize: 8.5, color: C.red, backgroundColor: C.redSoft, borderWidth: 0.5, borderColor: "#F3C6C1", borderRadius: 7, paddingVertical: 6, paddingHorizontal: 9, fontFamily: "Helvetica-Bold" },

  feedback: { marginTop: 8, borderRadius: 7, padding: 8, backgroundColor: C.greenSoft },
  feedbackTitle: { fontSize: 7, letterSpacing: 0.5, textTransform: "uppercase", fontFamily: "Helvetica-Bold", marginBottom: 2, color: C.green },
  explain: { marginTop: 6, borderRadius: 7, padding: 8, backgroundColor: C.blueSoft, borderWidth: 0.5, borderColor: "#D6E4FF" },
  explainTitle: { fontSize: 7, letterSpacing: 0.5, textTransform: "uppercase", fontFamily: "Helvetica-Bold", marginBottom: 2, color: C.blue },
  bodyTxt: { fontSize: 8.5, color: C.ink, lineHeight: 1.5 },

  footer: { position: "absolute", bottom: 18, left: 34, right: 34, flexDirection: "row", justifyContent: "space-between", borderTopWidth: 0.5, borderTopColor: C.line, paddingTop: 6 },
  footTxt: { fontSize: 7, color: C.muted },
});

/**
 * The built-in PDF fonts (Helvetica, Courier) only carry the WinAnsi character
 * set. Anything outside it printed as a wrong glyph ("1 <= N" came out "1 dN").
 * Map the symbols question papers actually use to plain equivalents; drop the rest.
 */
const SUBST: Record<string, string> = {
  "\u2264": "<=", "\u2265": ">=", "\u2260": "!=", "\u2248": "~", "\u2212": "-", "\u2192": "->", "\u2190": "<-", "\u21D2": "=>",
  "\u2194": "<->", "\u221A": "sqrt", "\u221E": "infinity", "\u2208": " in ", "\u2209": " not in ", "\u2211": "sum", "\u220F": "product",
  "\u2026": "...", "\u00A0": " ", "\u2009": " ", "\u200B": "", "\u2032": "'", "\u2033": "\"", "\u2264\u0338": "not <=", "\u230A": "floor(", "\u230B": ")",
  "\u2308": "ceil(", "\u2309": ")", "\u2081": "1", "\u2082": "2", "\u2083": "3", "\u1D62": "i", "\u2C7C": "j", "\u2099": "n", "\u2080": "0",
  "\u2074": "^4", "\u2075": "^5", "\u2076": "^6", "\u2077": "^7", "\u2078": "^8", "\u2079": "^9", "\u2070": "^0", "\u207F": "^n", "\u2715": "x", "\u2713": "v", "\u2714": "v",
};
const WIN_ANSI_EXTRA = new Set("\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178");
export function pdfSafe(text: string): string {
  let out = "";
  for (const ch of String(text ?? "")) {
    if (SUBST[ch] !== undefined) { out += SUBST[ch]; continue; }
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (c > 255) out += "?";
  }
  return out;
}

/** Leading spaces are collapsed by the PDF text layout; keep indentation with no-break spaces. */
function keepIndent(line: string): string {
  const t = line.replace(/\t/g, "    ");
  const m = t.match(/^ +/);
  return (m ? "\u00A0".repeat(m[0].length) + t.slice(m[0].length) : t) || " ";
}

/** Inline `code` spans inside a paragraph. */
function Inline({ text, style }: { text: string; style: any }) {
  const parts = text.split(/(`[^`]+`)/g).filter(Boolean);
  return (
    <Text style={style}>
      {parts.map((p, i) => (p.startsWith("`") && p.endsWith("`") && p.length > 2 ? <Text key={i} style={s.inlineCode}>{p.slice(1, -1)}</Text> : p))}
    </Text>
  );
}

const HEADING = /^(input( format)?|output( format)?|constraints?|sample( input| output)?( \d+)?|example( \d+)?|explanation|note|notes|hints?|task|problem( statement)?|function description|returns?)\s*:?\s*$/i;

/**
 * A question prompt as readable text: paragraphs, the usual contest headings in
 * bold, and ```fenced``` sample input/output in monospace boxes. Every block may
 * break across pages, so a long question never overflows its card.
 */
function RichText({ text, head }: { text: string; head?: ReactElement }) {
  const src = pdfSafe(text).replace(/\r\n?/g, "\n");
  const chunks = src.split(/```[^\n]*\n?/);
  const out: ReactElement[] = [];
  // A heading with nothing after it in its paragraph ("Sample input") waits here so
  // it is kept on the same page as the sample box that follows it.
  let pending: { key: string; text: string } | null = null;
  const flush = () => {
    if (pending) out.push(<Text key={pending.key} style={s.heading} minPresenceAhead={56}>{pending.text}</Text>);
    pending = null;
  };
  chunks.forEach((chunk, ci) => {
    if (ci % 2 === 1) {
      const lines = chunk.replace(/\n+$/, "").split("\n");
      const long = lines.length > 18;
      const box = (
        <View key={`c${ci}`} style={s.sampleBox} wrap={long}>
          {lines.map((l, li) => <Text key={li} style={s.sampleLine}>{keepIndent(l)}</Text>)}
        </View>
      );
      const head = pending as { key: string; text: string } | null;
      pending = null;
      // A short sample and its heading stay in one piece; a long one may continue
      // on the next page.
      out.push(head && !long ? <View key={`g${ci}`} wrap={false}><Text style={s.heading}>{head.text}</Text>{box}</View> : <View key={`g${ci}`}>{head ? <Text style={s.heading} minPresenceAhead={56}>{head.text}</Text> : null}{box}</View>);
      return;
    }
    const paras = chunk.split(/\n\s*\n/).map((p) => p.replace(/^\n+|\n+$/g, "")).filter((p) => p.trim());
    paras.forEach((p, pi) => {
      const lines = p.split("\n");
      // A heading line ("Input format") followed by its content in the same paragraph.
      flush();
      if (HEADING.test(lines[0].trim())) {
        const text = lines[0].trim().replace(/:$/, "");
        lines.shift();
        if (!lines.length) { pending = { key: `h${ci}-${pi}`, text }; return; }
        out.push(<Text key={`h${ci}-${pi}`} style={s.heading} minPresenceAhead={56}>{text}</Text>);
      }
      out.push(<Inline key={`p${ci}-${pi}`} style={s.para} text={lines.join("\n")} />);
    });
  });
  flush();
  // The question's title row travels with its first block, so a title is never
  // left alone at the foot of a page. Only when that block is short enough to
  // fit on a page; a very long opening paragraph may break as usual.
  if (head) {
    const firstLen = paragraphsLength(src);
    if (out.length && firstLen < 900) out[0] = <View key="first" wrap={false}>{head}{out[0]}</View>;
    else out.unshift(head);
  }
  return <View>{out}</View>;
}

/** Length of the opening block of a prompt (up to the first blank line or fence). */
function paragraphsLength(src: string): number {
  const end = src.search(/\n\s*\n|```/);
  return end < 0 ? src.length : end;
}

/** Student code, one line per row so long programs flow onto the next page. */
function CodeBlock({ code }: { code: string }) {
  const lines = pdfSafe(code).replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  return (
    <View style={s.codeBox}>
      {lines.map((l, i) => (
        <View key={i} style={s.codeRow} wrap={false}>
          <Text style={s.codeNo}>{i + 1}</Text>
          <Text style={s.codeLine}>{keepIndent(l)}</Text>
        </View>
      ))}
    </View>
  );
}

/** "Question 1: Metro Smart Card\n\nRiya travels..." -> title + body. */
function splitPrompt(prompt: string): { title: string; body: string } {
  const p = pdfSafe(prompt ?? "").replace(/\r\n?/g, "\n").trim();
  const nl = p.indexOf("\n");
  const first = nl < 0 ? p : p.slice(0, nl).trim();
  if (nl > 0 && first.length <= 90 && !/[.?]$/.test(first)) return { title: first, body: p.slice(nl + 1).trim() };
  return { title: "", body: p };
}

function asArray(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "number") return [v];
  return null;
}

function ObjectiveOptions({ a }: { a: StudentAnswer }) {
  if (a.type === "truefalse") {
    const opts: [string, boolean][] = [["True", true], ["False", false]];
    return (
      <View>
        {opts.map(([lbl, val]) => {
          const isC = a.correct === val;
          const chosen = a.response === val;
          return <OptRow key={lbl} letter={val ? "T" : "F"} text={lbl} correct={isC} chosen={chosen} />;
        })}
      </View>
    );
  }
  const options = Array.isArray(a.options) ? (a.options as string[]) : null;
  if (!options) return <SubjectiveAnswer a={a} />;
  const correct = asArray(a.correct) ?? [];
  const resp = asArray(a.response) ?? [];
  const answered = resp.length > 0;
  return (
    <View>
      {options.map((opt, i) => (
        <OptRow key={i} letter={LETTERS[i] ?? String(i + 1)} text={opt} correct={correct.includes(i)} chosen={resp.includes(i)} />
      ))}
      {!answered && <Text style={[s.noAns, { marginTop: 5 }]}>No answer submitted</Text>}
    </View>
  );
}

function OptRow({ letter, text, correct, chosen }: { letter: string; text: string; correct: boolean; chosen: boolean }) {
  const bg = correct ? C.greenSoft : chosen ? C.redSoft : C.white;
  const border = correct ? "#B7E0C8" : chosen ? "#E8C9C6" : C.line;
  return (
    <View style={[s.opt, { backgroundColor: bg, borderColor: border }]}>
      <Text style={s.optLetter}>{letter}</Text>
      <Text style={s.optTxt}>{pdfSafe(text)}</Text>
      {correct && <Text style={[s.tag, { color: C.green, backgroundColor: "#D6EFE0" }]}>CORRECT</Text>}
      {chosen && !correct && <Text style={[s.tag, { color: C.red, backgroundColor: "#F5D6D2" }]}>CHOSEN</Text>}
      {chosen && correct && <Text style={[s.tag, { color: C.green, backgroundColor: "#D6EFE0" }]}>YOUR PICK</Text>}
    </View>
  );
}

function SubjectiveAnswer({ a }: { a: StudentAnswer }) {
  const raw = a.response;
  const text = raw == null || String(raw).trim() === "" ? null : String(raw);
  const isCode = a.type === "coding";
  return (
    <View style={s.answerBlock}>
      <Text style={s.blockLbl} minPresenceAhead={40}>Student answer</Text>
      {text ? (
        isCode ? <CodeBlock code={text} /> : <Text style={s.textBox}>{pdfSafe(text)}</Text>
      ) : (
        <Text style={s.noAns}>No answer submitted</Text>
      )}
    </View>
  );
}

function QuestionCard({ a, index }: { a: StudentAnswer; index: number }) {
  const score = a.score;
  const max = a.maxScore ?? 0;
  const scored = score != null;
  const full = scored && score >= max && max > 0;
  const zero = scored && score <= 0;
  const scoreColor = full ? C.green : zero ? C.red : scored ? C.amber : C.muted;
  const objective = a.type === "mcq" || a.type === "multi" || a.type === "truefalse";

  const { title, body } = splitPrompt(a.prompt);
  // Notes written by the test-case grader read "Passed N of M test cases ...".
  const fromTests = /^Passed \d+ of \d+ test/.test(a.aiNotes ?? "");
  const headRow = (
    <View style={s.qHead} wrap={false}>
      <View style={{ flex: 1 }}>
        <Text style={s.qTitle}>{index + 1}. {title || `Question ${index + 1}`}</Text>
        <Text style={s.qType}>{a.type}{a.topic ? ` · ${pdfSafe(a.topic)}` : ""}</Text>
      </View>
      <Text style={[s.qPts, { color: scoreColor }]}>{scored ? `${score}/${max || "\u2014"} pt` : "Grading"}</Text>
    </View>
  );

  // The card may break across pages (a contest question is often longer than a
  // page). Forbidding that made the PDF engine squeeze the whole card into one
  // page, which is what overlapped the text. Only the title row stays together.
  return (
    <View style={s.qCard}>
      {body ? <RichText text={body} head={headRow} /> : headRow}

      {objective ? <ObjectiveOptions a={a} /> : <SubjectiveAnswer a={a} />}

      {a.aiNotes ? (
        <View style={[s.feedback, { backgroundColor: full ? C.greenSoft : zero ? C.redSoft : scored ? "#FDF4E3" : C.soft }]} wrap={false}>
          <Text style={[s.feedbackTitle, { color: scoreColor }]}>{fromTests ? "Test results" : "AI feedback"}</Text>
          <Text style={s.bodyTxt}>{pdfSafe(a.aiNotes)}</Text>
        </View>
      ) : null}

      {a.explanation ? (
        <View style={s.explain}>
          <Text style={s.explainTitle} minPresenceAhead={20}>Explanation</Text>
          <Text style={s.bodyTxt}>{pdfSafe(a.explanation)}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function StudentReportDoc({ brand, examTitle, student, attempt, totalQuestions, answers }: StudentReportData) {
  const accent = brand.accent || "#1E3A5F";
  const graded = attempt.status === "graded";
  const PASS_MARK = 40;
  const passed = attempt.score != null && attempt.score >= PASS_MARK;
  const scoreColor = attempt.score == null ? C.muted : passed ? C.green : C.red;
  return (
    <Document title={`${examTitle} — ${student.name}`}>
      <Page size="A4" style={s.page}>
        <View style={s.headerRow} fixed>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={brand.logoUrl} style={s.logo} />
          <Text style={s.college}>{brand.collegeName}</Text>
        </View>
        <View style={[s.accentBar, { backgroundColor: accent }]} fixed />

        <Text style={s.title}>{pdfSafe(examTitle)}</Text>
        <Text style={s.sub}>Individual answer sheet & feedback</Text>

        <View style={s.infoCard} wrap={false}>
          <View style={s.infoLeft}>
            <Text style={s.infoName}>{pdfSafe(student.name)}</Text>
            <Text style={s.infoMeta}>Roll No: {student.rollNo || "\u2014"}{student.section ? `   ·   Section: ${student.section}` : ""}</Text>
            {student.email ? <Text style={s.infoMeta}>{student.email}</Text> : null}
            <Text style={s.infoMeta}>Submitted: {fmtDate(attempt.submittedAt)}</Text>
          </View>
          <View style={s.scoreBox}>
            <Text style={[s.scoreNum, { color: scoreColor }]}>{graded && attempt.score != null ? attempt.score : "\u2014"}<Text style={{ fontSize: 11, color: C.muted }}>/100</Text></Text>
            <Text style={s.scoreLbl}>{graded ? "Marks scored" : "Grading"}</Text>
            {graded && attempt.score != null ? (
              <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", marginTop: 3, color: passed ? C.green : C.red }}>{passed ? "PASS" : "FAIL"}</Text>
            ) : null}
          </View>
        </View>

        <Text style={s.sectionLabel}>Answer breakdown ({answers.length}{totalQuestions ? ` of ${totalQuestions}` : ""})</Text>
        {answers.length === 0 ? (
          <Text style={s.noAns}>No stored answers for this attempt.</Text>
        ) : (
          answers.map((a, i) => <QuestionCard key={a.id} a={a} index={i} />)
        )}

        <View style={s.footer} fixed>
          <Text style={s.footTxt}>{brand.collegeName} · Proview by Skilltimate</Text>
          <Text style={s.footTxt} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export async function generateStudentReport(data: StudentReportData): Promise<Blob> {
  return await pdf(<StudentReportDoc {...data} />).toBlob();
}
