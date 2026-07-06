import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import { api, type Review as ReviewData, type ReviewQuestion } from "../lib/api";
import { Icon, Pill, Loader, EmptyState } from "../components/ui";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export function Review() {
  const { attemptId } = useParams();
  const [, navigate] = useLocation();
  const [data, setData] = useState<ReviewData | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!attemptId) return;
    api.review(attemptId).then(setData).catch((e) => setErr(e instanceof Error ? e.message : "Failed to load review"));
  }, [attemptId]);

  if (err) return <div className="content"><EmptyState icon="cloud-off" title="Can't load review" sub={err} /></div>;
  if (!data) return <Loader label="Loading your results…" />;

  return (
    <div className="main-area" style={{ background: "var(--color-page)", minHeight: "100vh" }}>
      <header className="topbar">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate("/finished")}><Icon name="arrow-left" /> Back</button>
          <div>
            <div className="mono-label">Review</div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{data.exam?.title}</div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}><div className="mono-label">Score</div><div className="stat-num" style={{ fontSize: 20 }}>{data.attempt.score ?? 0}%</div></div>
      </header>

      <main className="content">
        <ReviewBody data={data} />
      </main>
    </div>
  );
}

// Shared review contents — used both on the full Review route and inside the
// slide-in review drawer. Score only, no integrity metric.
export function ReviewBody({ data }: { data: ReviewData }) {
  const earned = data.questions.reduce((s, q) => s + (q.score || 0), 0);
  const max = data.questions.reduce((s, q) => s + q.maxScore, 0);
  return (
    <>
      <div className="card" style={{ padding: 18, marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <div className="mono-label">Score</div>
          <div className="stat-num" style={{ fontSize: 26, color: "var(--brand)" }}>{data.attempt.score ?? 0}%</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="mono-label">Marks earned</div>
          <div className="stat-num" style={{ fontSize: 22 }}>{Math.round(earned * 10) / 10} / {max}</div>
        </div>
      </div>
      <div style={{ display: "grid", gap: 16 }}>
        {data.questions.map((q, i) => <ReviewCard key={q.id} q={q} index={i} />)}
      </div>
    </>
  );
}

function ReviewCard({ q, index }: { q: ReviewQuestion; index: number }) {
  const full = q.score != null && q.score >= q.maxScore;
  const zero = q.score != null && q.score <= 0;
  const tone = full ? "success" : zero ? "danger" : "warn";

  return (
    <div className="card rise" style={{ padding: 22 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10 }}>
          <span className="mono-label" style={{ paddingTop: 3 }}>Q{index + 1}</span>
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.5 }}>{q.prompt}</div>
        </div>
        <Pill tone={tone}>{q.score ?? 0} / {q.maxScore} pt</Pill>
      </div>

      {q.options && (q.type === "mcq" || q.type === "multi" || q.type === "truefalse" || q.type === "fillblank") ? (
        <ObjectiveReview q={q} />
      ) : (
        <SubjectiveReview q={q} />
      )}

      {q.aiNotes && (
        <div style={{ marginTop: 14, background: "var(--color-brand-soft)", borderRadius: 11, padding: "12px 14px" }}>
          <div className="mono-label" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}><Icon name="sparkles" size={13} /> AI feedback</div>
          <div style={{ fontSize: 14, color: "var(--color-ink)", lineHeight: 1.55 }}>{q.aiNotes}</div>
        </div>
      )}

      {q.explanation && (
        <div style={{ marginTop: 14, background: "#f0f6ff", border: "1px solid #d6e4ff", borderRadius: 11, padding: "12px 14px" }}>
          <div className="mono-label" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, color: "#1A3EBF" }}><Icon name="lightbulb" size={13} /> Explanation</div>
          <div style={{ fontSize: 14, color: "var(--color-ink)", lineHeight: 1.55 }}>{q.explanation}</div>
        </div>
      )}
    </div>
  );
}

function ObjectiveReview({ q }: { q: ReviewQuestion }) {
  const correct = q.correct;
  const resp = q.response;
  const isCorrectOpt = (i: number): boolean => (Array.isArray(correct) ? (correct as number[]).includes(i) : correct === i);
  const isChosen = (i: number): boolean => (Array.isArray(resp) ? (resp as number[]).includes(i) : resp === i);

  if (q.type === "truefalse") {
    const opts = [["True", true], ["False", false]] as [string, boolean][];
    return (
      <div style={{ display: "grid", gap: 8 }}>
        {opts.map(([lbl, val]) => {
          const chosen = resp === val;
          const isC = correct === val;
          return (
            <div key={lbl} className={`opt-row ${isC ? "rev-correct" : chosen ? "rev-wrong" : ""}`}>
              <span className="opt-letter">{val ? "T" : "F"}</span>
              <span style={{ flex: 1 }}>{lbl}</span>
              {isC && <Icon name="check" size={16} className="text-[var(--color-success)]" />}
              {chosen && !isC && <Icon name="x" size={16} className="text-[var(--color-danger)]" />}
            </div>
          );
        })}
      </div>
    );
  }

  if (!q.options) return null;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {q.options.map((opt, i) => {
        const isC = isCorrectOpt(i);
        const chosen = isChosen(i);
        return (
          <div key={i} className={`opt-row ${isC ? "rev-correct" : chosen ? "rev-wrong" : ""}`}>
            <span className="opt-letter">{LETTERS[i]}</span>
            <span style={{ flex: 1 }}>{opt}</span>
            {isC && <Icon name="check" size={16} className="text-[var(--color-success)]" />}
            {chosen && !isC && <Icon name="x" size={16} className="text-[var(--color-danger)]" />}
          </div>
        );
      })}
    </div>
  );
}

function SubjectiveReview({ q }: { q: ReviewQuestion }) {
  const resp = q.response == null || String(q.response).trim() === "" ? null : String(q.response);
  return (
    <div>
      <div className="mono-label" style={{ marginBottom: 6 }}>Your answer</div>
      {resp ? (
        <pre style={{ whiteSpace: "pre-wrap", fontFamily: q.type === "coding" ? "var(--font-mono)" : "var(--font-sans)", fontSize: 13.5, background: q.type === "coding" ? "#0f1b2b" : "#f6f7f9", color: q.type === "coding" ? "#e6edf5" : "var(--color-ink)", padding: 14, borderRadius: 11, lineHeight: 1.6, border: "1px solid var(--color-line)" }}>{resp}</pre>
      ) : (
        <div style={{ color: "var(--color-muted)", fontStyle: "italic", fontSize: 14 }}>No answer submitted.</div>
      )}
    </div>
  );
}
