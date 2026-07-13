// Per-student answer sheet PDF: branded header, score summary, then every question
// with the student's answer, the correct answer (objective), AI feedback and the
// explanation. Handed to students. Exported as a Blob via generateStudentReport().
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
  title: { fontSize: 16, fontFamily: "Helvetica-Bold", color: C.ink },
  sub: { fontSize: 9, color: C.ink2, marginTop: 3 },

  infoCard: { flexDirection: "row", justifyContent: "space-between", borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 14, marginTop: 14, backgroundColor: C.soft },
  infoName: { fontSize: 13, fontFamily: "Helvetica-Bold", color: C.ink },
  infoMeta: { fontSize: 8.5, color: C.ink2, marginTop: 3 },
  scoreBox: { alignItems: "flex-end" },
  scoreNum: { fontSize: 24, fontFamily: "Helvetica-Bold" },
  scoreLbl: { fontSize: 7, letterSpacing: 0.6, color: C.muted, textTransform: "uppercase" },

  sectionLabel: { fontSize: 8, letterSpacing: 1, color: C.muted, fontFamily: "Helvetica-Bold", textTransform: "uppercase", marginTop: 18, marginBottom: 8 },

  qCard: { borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 12, marginBottom: 10 },
  qHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 },
  qPrompt: { fontSize: 10, fontFamily: "Helvetica-Bold", color: C.ink, lineHeight: 1.4 },
  qType: { fontSize: 6.5, letterSpacing: 0.5, color: C.muted, textTransform: "uppercase", marginTop: 3 },
  qPts: { fontSize: 9, fontFamily: "Helvetica-Bold" },

  opt: { flexDirection: "row", alignItems: "flex-start", gap: 7, borderWidth: 1, borderColor: C.line, borderRadius: 7, paddingVertical: 6, paddingHorizontal: 8, marginTop: 4, backgroundColor: C.white },
  optLetter: { width: 15, height: 15, borderRadius: 4, backgroundColor: "#EEF1F5", color: C.ink2, fontSize: 8, fontFamily: "Helvetica-Bold", textAlign: "center", paddingTop: 2.5 },
  optTxt: { fontSize: 9, color: C.ink, flex: 1 },
  tag: { fontSize: 6.5, fontFamily: "Helvetica-Bold", paddingHorizontal: 4, paddingVertical: 1.5, borderRadius: 3 },

  answerBlock: { marginTop: 4 },
  blockLbl: { fontSize: 7, letterSpacing: 0.5, color: C.muted, textTransform: "uppercase", marginBottom: 3, fontFamily: "Helvetica-Bold" },
  codeBox: { fontFamily: "Courier", fontSize: 8.5, backgroundColor: "#0F1B2B", color: "#E6EDF5", padding: 9, borderRadius: 7, lineHeight: 1.5 },
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
      <Text style={s.optTxt}>{text}</Text>
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
      <Text style={s.blockLbl}>Student answer</Text>
      {text ? (
        <Text style={isCode ? s.codeBox : s.textBox}>{text}</Text>
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

  return (
    <View style={s.qCard} wrap={false}>
      <View style={s.qHead}>
        <View style={{ flex: 1 }}>
          <Text style={s.qPrompt}>{index + 1}. {a.prompt}</Text>
          <Text style={s.qType}>{a.type}{a.topic ? ` · ${a.topic}` : ""}</Text>
        </View>
        <Text style={[s.qPts, { color: scoreColor }]}>{scored ? `${score}/${max || "\u2014"} pt` : "Grading"}</Text>
      </View>

      {objective ? <ObjectiveOptions a={a} /> : <SubjectiveAnswer a={a} />}

      {a.aiNotes ? (
        <View style={s.feedback}>
          <Text style={s.feedbackTitle}>AI feedback</Text>
          <Text style={s.bodyTxt}>{a.aiNotes}</Text>
        </View>
      ) : null}

      {a.explanation ? (
        <View style={s.explain}>
          <Text style={s.explainTitle}>Explanation</Text>
          <Text style={s.bodyTxt}>{a.explanation}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function StudentReportDoc({ brand, examTitle, student, attempt, totalQuestions, answers }: StudentReportData) {
  const accent = brand.accent || "#1E3A5F";
  const graded = attempt.status === "graded";
  const scoreColor = attempt.score == null ? C.muted : attempt.score >= 50 ? C.green : C.red;
  return (
    <Document title={`${examTitle} — ${student.name}`}>
      <Page size="A4" style={s.page}>
        <View style={s.headerRow} fixed>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={brand.logoUrl} style={s.logo} />
          <Text style={s.college}>{brand.collegeName}</Text>
        </View>
        <View style={[s.accentBar, { backgroundColor: accent }]} fixed />

        <Text style={s.title}>{examTitle}</Text>
        <Text style={s.sub}>Individual answer sheet & feedback</Text>

        <View style={s.infoCard}>
          <View>
            <Text style={s.infoName}>{student.name}</Text>
            <Text style={s.infoMeta}>Roll No: {student.rollNo || "\u2014"}{student.section ? `   ·   Section: ${student.section}` : ""}</Text>
            {student.email ? <Text style={s.infoMeta}>{student.email}</Text> : null}
            <Text style={s.infoMeta}>Submitted: {fmtDate(attempt.submittedAt)}</Text>
          </View>
          <View style={s.scoreBox}>
            <Text style={[s.scoreNum, { color: scoreColor }]}>{graded && attempt.score != null ? attempt.score : "\u2014"}<Text style={{ fontSize: 11, color: C.muted }}>/100</Text></Text>
            <Text style={s.scoreLbl}>{graded ? "Marks scored" : "Grading"}</Text>
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
