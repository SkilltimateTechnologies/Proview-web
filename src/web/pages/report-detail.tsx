import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { ArrowLeft, Download, ChevronRight } from "lucide-react";
import { api } from "../lib/api";
import { PageHeader } from "../components/shell";
import { Loader, Pill, Drawer, usePagination, Pager } from "../components/ui";

type Row = { attemptId: string; studentId: string; name: string; rollNo: string; email: string | null; score: number | null; status: string; submittedAt: string | number | null };

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
    const header = ["#", "Name", "Roll No", "Email", "Score", "Status"];
    const lines = results.map((r, i) => [
      i + 1, r.name, r.rollNo, r.email ?? "", r.score ?? "", r.status,
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
            <span className="stat-num w-14 sm:w-20 text-right shrink-0 text-[var(--color-ink)]">{r.score ?? "—"}</span>
            <ChevronRight size={16} className="text-[var(--color-muted)] w-4 shrink-0" />
          </button>
        ))}
      </div>

      <Pager page={curPage} pageCount={pageCount} from={from} to={to} total={results.length} onChange={setPage} unit="students" />

      {openAttempt && <AttemptDrawer examId={examId} row={openAttempt} onClose={() => setOpenAttempt(null)} />}
    </div>
  );
}

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

  return (
    <Drawer eyebrow="Student report" title={row.name} subtitle={`${row.rollNo}${row.email ? " · " + row.email : ""}`} onClose={onClose} width="max-w-3xl">
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="card p-4"><div className="stat-num text-[1.5rem]">{row.score ?? "—"}</div><div className="mono-label mt-1">Score</div></div>
        <div className="card p-4"><div className="text-sm font-semibold text-[var(--color-ink)] capitalize pt-1">{row.status}</div><div className="mono-label mt-1">Status</div></div>
      </div>

      {q.isLoading ? (
        <Loader />
      ) : !d ? (
        <div className="card p-6 text-center text-sm text-[var(--color-ink2)]">Detailed breakdown not available for this attempt.</div>
      ) : (
        <>
          <div className="mono-label mb-2">Answer breakdown ({d.answers.length})</div>
          {d.answers.length === 0 ? (
            <div className="card p-4 text-sm text-[var(--color-ink2)] mb-6">No stored answers for this attempt.</div>
          ) : (
            <div className="space-y-3 mb-6">
              {d.answers.map((a, i) => (
                <div key={a.id} className="rounded-xl border border-[var(--color-line)] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[var(--color-ink)]">{i + 1}. {a.prompt}</div>
                      <div className="mono-label mt-1">{a.type}{a.topic ? ` · ${a.topic}` : ""}</div>
                    </div>
                    <span className="stat-num text-sm shrink-0" style={{ color: (a.score ?? 0) >= (a.maxScore ?? 1) ? "#2e7d5b" : (a.score ?? 0) > 0 ? "#b7791f" : "#c0453b" }}>
                      {a.score ?? 0}/{a.maxScore ?? "—"}
                    </span>
                  </div>
                  {a.aiNotes && <div className="text-xs text-[var(--color-ink2)] mt-2 bg-[var(--color-brand-soft)] rounded-lg px-2.5 py-2">{a.aiNotes}</div>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}
