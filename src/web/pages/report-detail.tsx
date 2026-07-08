import { useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { ArrowLeft, Download, ChevronRight, Check, X, Sparkles, Lightbulb } from "lucide-react";
import { api } from "../lib/api";
import { PageHeader } from "../components/shell";
import { Loader, Pill, Drawer, usePagination, Pager } from "../components/ui";

type Row = { attemptId: string; studentId: string; name: string; rollNo: string; email: string | null; section: string; score: number | null; status: string; submittedAt: string | number | null };

function fmtSubmitted(t: string | number | null | undefined) {
  if (!t) return "—";
  return new Date(t).toLocaleString("en-IN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

export default function ReportDetail() {
  const { examId } = useParams<{ examId: string }>();
  const [openAttempt, setOpenAttempt] = useState<Row | null>(null);
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["report", examId],
    queryFn: async () => {
      const res = await api.reports[":examId"].$get({ param: { examId } });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
  });

  if (q.isLoading) return <Loader />;
  if (!q.data || "message" in q.data) {
    return (
      <div>
        <Link to="/reports" className="inline-flex items-center gap-1.5 text-sm text-[var(--color-ink2)] mb-4"><ArrowLeft size={16} /> Back</Link>
        <div className="card p-10 text-center text-[var(--color-ink2)]">Report not available.</div>
      </div>
    );
  }

  const { exam, results } = q.data as { exam: { title: string; status: string }; results: Row[] };
  const topper = results[0];
  const PS = 20;
  const pageCount = Math.max(1, Math.ceil(results.length / PS));
  const curPage = Math.min(page, pageCount);
  const pageResults = results.slice((curPage - 1) * PS, curPage * PS);
  const from = results.length === 0 ? 0 : (curPage - 1) * PS + 1;
  const to = Math.min(curPage * PS, results.length);

  function exportCsv() {
    const header = ["Name", "Roll No", "Section", "Score"];
    const lines = results.map((r) => [
      r.name, r.rollNo, r.section ?? "", r.score ?? "",
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const csv = [header.join(","), ...lines].join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${exam.title.replace(/[^\w]+/g, "_")}_report.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="rise">
      <Link to="/reports" className="inline-flex items-center gap-1.5 text-sm text-[var(--color-ink2)] mb-3"><ArrowLeft size={16} /> Reports</Link>
      <PageHeader
        eyebrow="Assessment report"
        title={exam.title}
        action={
          <div className="flex items-center gap-2">
            <button className="btn btn-ghost" onClick={exportCsv}><Download size={16} /> Export CSV</button>
            <Pill label={exam.status.toUpperCase()} color="#2e7d5b" />
          </div>
        }
      />

      <div className="grid grid-cols-3 gap-4 mb-4">
        <div className="card p-5">
          <div className="stat-num text-[1.8rem]">{results.length}</div>
          <div className="mono-label mt-1">Attempts</div>
        </div>
        <div className="card p-5">
          <div className="stat-num text-[1.8rem]">{topper?.score ?? "—"}</div>
          <div className="mono-label mt-1">Highest score</div>
        </div>
        <div className="card p-5">
          <div className="stat-num text-[1.8rem]">
            {results.filter((r) => (r.score ?? 0) >= 40).length}
          </div>
          <div className="mono-label mt-1">Passed</div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center gap-3 sm:gap-4 px-3 sm:px-4 py-3 border-b border-[var(--color-line)]">
          <span className="mono-label w-6 sm:w-8 shrink-0">#</span>
          <span className="mono-label flex-1 min-w-0">Student</span>
          <span className="mono-label w-28 text-right shrink-0 hidden sm:block">Submitted</span>
          <span className="mono-label w-14 sm:w-20 text-right shrink-0">Score</span>
          <span className="w-4 shrink-0" />
        </div>
        {pageResults.map((r, i) => (
          <button
            key={r.rollNo + i}
            onClick={() => setOpenAttempt(r)}
            className="w-full flex items-center gap-3 sm:gap-4 px-3 sm:px-4 py-3 border-b border-[var(--color-line)] last:border-0 text-left hover:bg-[var(--color-brand-soft)] transition"
          >
            <span className="mono-label w-6 sm:w-8 shrink-0">{String((curPage - 1) * PS + i + 1).padStart(2, "0")}</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-[var(--color-ink)] truncate">{r.name}</div>
              <div className="text-xs text-[var(--color-muted)] truncate" style={{ fontFamily: "var(--font-mono)" }}>{r.rollNo}</div>
            </div>
            <span className="w-28 text-right shrink-0 hidden sm:block text-xs text-[var(--color-muted)]" style={{ fontFamily: "var(--font-mono)" }}>{fmtSubmitted(r.submittedAt)}</span>
            {r.status === "graded" ? (
              <span className="stat-num w-14 sm:w-20 text-right shrink-0 text-[var(--color-ink)]">{r.score ?? "—"}</span>
            ) : (
              <span className="w-14 sm:w-20 text-right shrink-0 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "#b7791f", fontFamily: "var(--font-mono)" }}>Grading</span>
            )}
            <ChevronRight size={16} className="text-[var(--color-muted)] w-4 shrink-0" />
          </button>
        ))}
      </div>

      <Pager page={curPage} pageCount={pageCount} from={from} to={to} total={results.length} onChange={setPage} unit="students" />

      {openAttempt && <AttemptDrawer examId={examId} row={openAttempt} onClose={() => setOpenAttempt(null)} />}
    </div>
  );
}

type AnswerRow = {
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
  autoGraded: unknown;
};

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

function AttemptDrawer({ examId, row, onClose }: { examId: string; row: Row; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["attempt", examId, row.attemptId],
    queryFn: async () => {
      const res = await api.reports[":examId"].attempt[":attemptId"].$get({ param: { examId, attemptId: row.attemptId } });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
  });

  const d = q.data && !("message" in q.data) ? q.data : null;
  const answers = (d?.answers ?? []) as AnswerRow[];

  return (
    <Drawer eyebrow="Student report" title={row.name} subtitle={`${row.rollNo}${row.email ? " · " + row.email : ""}`} onClose={onClose} width="max-w-3xl">
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="card p-4">{row.status === "graded" ? (<div className="stat-num text-[1.6rem]" style={{ color: "var(--brand)" }}>{row.score != null ? `${row.score}/100` : "—"}</div>) : (<div className="stat-num text-[1.6rem]" style={{ color: "#b7791f" }}>Grading…</div>)}<div className="mono-label mt-1">Marks scored</div></div>
        <div className="card p-4"><div className="stat-num text-[1.6rem] text-[var(--color-ink)]">{fmtSubmitted(row.submittedAt)}</div><div className="mono-label mt-1">Submitted</div></div>
      </div>

      {q.isLoading ? (
        <Loader />
      ) : !d ? (
        <div className="card p-6 text-center text-sm text-[var(--color-ink2)]">Detailed breakdown not available for this attempt.</div>
      ) : (
        <>
          <div className="mono-label mb-2">Answer breakdown ({answers.length})</div>
          {answers.length === 0 ? (
            <div className="card p-4 text-sm text-[var(--color-ink2)] mb-6">No stored answers for this attempt.</div>
          ) : (
            <div className="space-y-4 mb-6">
              {answers.map((a, i) => <AnswerCard key={a.id} a={a} index={i} />)}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}

function AnswerCard({ a, index }: { a: AnswerRow; index: number }) {
  const score = a.score ?? 0;
  const maxScore = a.maxScore ?? 0;
  const scored = a.score != null;
  const full = scored && score >= maxScore && maxScore > 0;
  const zero = scored && score <= 0;
  const scoreColor = full ? "#2e7d5b" : zero ? "#c0453b" : scored ? "#b7791f" : "var(--color-muted)";
  const objective = a.type === "mcq" || a.type === "multi" || a.type === "truefalse" || a.type === "fillblank";

  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--color-ink)] leading-relaxed">{index + 1}. {a.prompt}</div>
          <div className="mono-label mt-1 uppercase">{a.type}{a.topic ? ` · ${a.topic}` : ""}</div>
        </div>
        <span className="stat-num text-sm shrink-0 whitespace-nowrap" style={{ color: scoreColor }}>
          {scored ? `${score}/${maxScore || "—"} pt` : "Grading…"}
        </span>
      </div>

      {objective ? <ObjectiveReview a={a} /> : <SubjectiveReview a={a} />}

      {a.aiNotes && (
        <div className="mt-3 rounded-lg px-3 py-2.5" style={{ background: "var(--color-brand-soft)" }}>
          <div className="mono-label flex items-center gap-1.5 mb-1"><Sparkles size={13} /> AI feedback</div>
          <div className="text-[13.5px] text-[var(--color-ink)] leading-relaxed">{a.aiNotes}</div>
        </div>
      )}

      {a.explanation && (
        <div className="mt-3 rounded-lg px-3 py-2.5" style={{ background: "#f0f6ff", border: "1px solid #d6e4ff" }}>
          <div className="mono-label flex items-center gap-1.5 mb-1" style={{ color: "#1A3EBF" }}><Lightbulb size={13} /> Explanation</div>
          <div className="text-[13.5px] text-[var(--color-ink)] leading-relaxed">{a.explanation}</div>
        </div>
      )}
    </div>
  );
}

function optStyle(state: "correct" | "wrong" | "none"): CSSProperties {
  const base: CSSProperties = {
    display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px",
    border: "1px solid var(--color-line)", borderRadius: 10, background: "#fff", fontSize: 14,
  };
  if (state === "correct") return { ...base, borderColor: "#b7e0c8", background: "#e7f5ee" };
  if (state === "wrong") return { ...base, borderColor: "#e8c9c6", background: "#fbeceb" };
  return base;
}

const letterStyle: CSSProperties = {
  width: 24, height: 24, borderRadius: 6, background: "#eef1f5", color: "var(--color-ink2)",
  display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 12, flex: "none",
};

function ObjectiveReview({ a }: { a: AnswerRow }) {
  const correct = a.correct;
  const resp = a.response;

  if (a.type === "truefalse") {
    const opts: [string, boolean][] = [["True", true], ["False", false]];
    return (
      <div className="grid gap-2">
        {opts.map(([lbl, val]) => {
          const chosen = resp === val;
          const isC = correct === val;
          return (
            <div key={lbl} style={optStyle(isC ? "correct" : chosen ? "wrong" : "none")}>
              <span style={letterStyle}>{val ? "T" : "F"}</span>
              <span style={{ flex: 1 }}>{lbl}</span>
              {isC && <Check size={16} color="#2e7d5b" />}
              {chosen && !isC && <X size={16} color="#c0453b" />}
            </div>
          );
        })}
      </div>
    );
  }

  const options = Array.isArray(a.options) ? (a.options as string[]) : null;
  if (!options) return <SubjectiveReview a={a} />;

  const isCorrectOpt = (i: number) => (Array.isArray(correct) ? (correct as number[]).includes(i) : correct === i);
  const isChosen = (i: number) => (Array.isArray(resp) ? (resp as number[]).includes(i) : resp === i);
  const answered = Array.isArray(resp) ? resp.length > 0 : resp != null;

  return (
    <div className="grid gap-2">
      {options.map((opt, i) => {
        const isC = isCorrectOpt(i);
        const chosen = isChosen(i);
        return (
          <div key={i} style={optStyle(isC ? "correct" : chosen ? "wrong" : "none")}>
            <span style={letterStyle}>{LETTERS[i] ?? i + 1}</span>
            <span style={{ flex: 1 }}>{opt}</span>
            {isC && <Check size={16} color="#2e7d5b" />}
            {chosen && !isC && <X size={16} color="#c0453b" />}
          </div>
        );
      })}
      {!answered && <div className="text-[13px] font-semibold mt-1" style={{ color: "#c0453b", background: "#fdecea", border: "1px solid #f3c6c1", borderRadius: 8, padding: "8px 12px" }}>No answer submitted.</div>}
    </div>
  );
}

function SubjectiveReview({ a }: { a: AnswerRow }) {
  const raw = a.response;
  const text = raw == null || String(raw).trim() === "" ? null : String(raw);
  const isCode = a.type === "coding";
  return (
    <div>
      <div className="mono-label mb-1.5">Student answer</div>
      {text ? (
        <pre style={{
          whiteSpace: "pre-wrap", fontFamily: isCode ? "var(--font-mono)" : "var(--font-sans)", fontSize: 13,
          background: isCode ? "#0f1b2b" : "#f6f7f9", color: isCode ? "#e6edf5" : "var(--color-ink)",
          padding: 12, borderRadius: 10, lineHeight: 1.6, border: "1px solid var(--color-line)", margin: 0,
        }}>{text}</pre>
      ) : (
        <div className="text-[13px] font-semibold" style={{ color: "#c0453b", background: "#fdecea", border: "1px solid #f3c6c1", borderRadius: 8, padding: "8px 12px" }}>No answer submitted.</div>
      )}
    </div>
  );
}
