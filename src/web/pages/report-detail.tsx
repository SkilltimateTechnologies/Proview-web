import { useState, useEffect, useRef, type CSSProperties } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { ArrowLeft, Download, ChevronRight, Check, X, Sparkles, Lightbulb, MoreVertical, UserX, Trash2, FileText, FileSpreadsheet, Files, ChevronDown, Loader2 } from "lucide-react";
import JSZip from "jszip";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { PageHeader } from "../components/shell";
import { Loader, Pill, Drawer, usePagination, Pager } from "../components/ui";
import { safeName, fmtFileDate, type Brand } from "../lib/pdf/theme";
import type { StudentAnswer } from "../lib/pdf/student-report";

type Row = { attemptId: string; studentId: string; name: string; rollNo: string; email: string | null; section: string; score: number | null; status: string; submittedAt: string | number | null; absent?: boolean; disconnected?: boolean; answeredCount?: number };

function saveBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** Fetch one attempt's full answer sheet and shape it for the student PDF. */
async function fetchStudentData(examId: string, row: Row) {
  const res = await api.reports[":examId"].attempt[":attemptId"].$get({ param: { examId, attemptId: row.attemptId } });
  if (!res.ok) throw new Error("Failed to load attempt");
  const d = await res.json();
  if ("message" in d) throw new Error("Attempt not available");
  return {
    student: { name: d.student.name, rollNo: d.student.rollNo, email: d.student.email, section: row.section },
    attempt: { score: d.attempt.score, status: d.attempt.status, submittedAt: d.attempt.submittedAt },
    answers: d.answers as StudentAnswer[],
  };
}

function fmtSubmitted(t: string | number | null | undefined) {
  if (!t) return "—";
  return new Date(t).toLocaleString("en-IN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

export default function ReportDetail() {
  const { examId } = useParams<{ examId: string }>();
  const qc = useQueryClient();
  const { me } = useSession();
  const [openAttempt, setOpenAttempt] = useState<Row | null>(null);
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState<{ row: Row; action: "absent" | "remove" } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [statFilter, setStatFilter] = useState<string>("all");
  const [sectionFilter, setSectionFilter] = useState<string>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const q = useQuery({
    queryKey: ["report", examId],
    queryFn: async () => {
      const res = await api.reports[":examId"].$get({ param: { examId } });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["report", examId] });
  const markAbsent = useMutation({
    mutationFn: async (studentId: string) => {
      const res = await api.reports[":examId"].roster["mark-absent"].$post({ param: { examId }, json: { studentId } });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
    onSuccess: () => { refresh(); setConfirm(null); },
  });
  const removeStudent = useMutation({
    mutationFn: async (studentId: string) => {
      const res = await api.reports[":examId"].roster.remove.$post({ param: { examId }, json: { studentId } });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
    onSuccess: () => { refresh(); setConfirm(null); },
  });
  const bulkRemove = useMutation({
    mutationFn: async (studentIds: string[]) => {
      const res = await api.reports[":examId"].roster["bulk-remove"].$post({ param: { examId }, json: { studentIds } });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
    onSuccess: () => { refresh(); setSelected(new Set()); setBulkConfirm(false); },
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

  const { exam, results, totalQuestions } = q.data as { exam: { title: string; status: string }; results: Row[]; totalQuestions?: number };
  const topper = results[0];

  const BANDS = [90, 80, 70, 60, 50];
  const bandCount = (min: number) => results.filter((r) => !r.absent && (r.score ?? 0) >= min).length;
  const matchStat = (r: Row) => {
    if (statFilter === "attempts") return !r.absent;
    if (statFilter === "absent") return !!r.absent;
    if (statFilter.startsWith("b")) return !r.absent && (r.score ?? 0) >= Number(statFilter.slice(1));
    return true; // "all"
  };
  const sections = Array.from(new Set(results.map((r) => r.section).filter(Boolean))).sort();
  const filtered = results.filter((r) => {
    if (sectionFilter !== "all" && r.section !== sectionFilter) return false;
    return matchStat(r);
  });

  const PS = 20;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PS));
  const curPage = Math.min(page, pageCount);
  const pageResults = filtered.slice((curPage - 1) * PS, curPage * PS);
  const from = filtered.length === 0 ? 0 : (curPage - 1) * PS + 1;
  const to = Math.min(curPage * PS, filtered.length);

  const allIds = filtered.map((r) => r.studentId);
  const allSelected = allIds.length > 0 && allIds.every((sid) => selected.has(sid));
  const toggleAll = () => {
    setSelected((prev) => (allIds.every((sid) => prev.has(sid)) ? new Set() : new Set(allIds)));
  };
  const toggleOne = (sid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid); else next.add(sid);
      return next;
    });
  };

  // Brand identity carried onto every generated PDF (matches the sidebar badge).
  const brand: Brand = {
    collegeName: me?.tenant?.name ?? "Proview",
    logoUrl: `${window.location.origin}/skilltimate-logo.png`,
    accent: me?.tenant?.primaryColor || "#1E3A5F",
  };
  // The section the exports describe: current section filter, or all sections.
  const sectionLabel = sectionFilter === "all" ? "All sections" : sectionFilter;
  const sectionRows = sectionFilter === "all" ? results : results.filter((r) => r.section === sectionFilter);
  // Report file naming: "Section Name - date" (e.g. "IT-A - Jan 10-2026").
  const examDate = fmtFileDate((exam as any).endAt ?? (exam as any).startAt ?? (exam as any).createdAt);
  const fileBase = safeName(`${sectionLabel} - ${examDate}`);

  function exportCsv() {
    const header = ["Rank", "Name", "Roll No", "Section", "Status", "Score"];
    const present = [...sectionRows].filter((r) => !r.absent && r.score != null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const rankMap = new Map<string, number>();
    let rk = 0, last: number | null = null;
    for (const r of present) { if (r.score !== last) { rk++; last = r.score; } rankMap.set(r.attemptId, rk); }
    const ordered = [...sectionRows].sort((a, b) => (a.absent ? 1 : 0) - (b.absent ? 1 : 0) || (b.score ?? -1) - (a.score ?? -1));
    const lines = ordered.map((r) => {
      const status = r.absent ? "Absent" : r.disconnected ? `Disconnected (${r.answeredCount ?? 0})` : r.status === "graded" ? "Submitted" : "Grading";
      return [
        r.absent ? "" : rankMap.get(r.attemptId) ?? "", r.name, r.rollNo, r.section ?? "", status, r.absent ? "A" : r.score ?? "",
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");
    });
    const csv = [header.join(","), ...lines].join("\r\n");
    saveBlob(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }), `${fileBase}.csv`);
  }

  async function exportSectionPdf() {
    setBusy("section");
    try {
      const { generateSectionReport } = await import("../lib/pdf/section-report");
      const blob = await generateSectionReport({ brand, examTitle: exam.title, section: sectionLabel, rows: sectionRows });
      saveBlob(blob, `${fileBase}.pdf`);
    } catch (e) {
      alert("Could not generate the section report PDF.");
      console.error(e);
    } finally {
      setBusy(null);
    }
  }

  async function exportStudentPdf(row: Row) {
    setBusy(`one:${row.attemptId}`);
    try {
      const { generateStudentReport } = await import("../lib/pdf/student-report");
      const d = await fetchStudentData(examId, row);
      const blob = await generateStudentReport({ brand, examTitle: exam.title, totalQuestions, ...d });
      saveBlob(blob, `${safeName(`${row.name} - ${row.rollNo}`)}.pdf`);
    } catch (e) {
      alert("Could not generate this student's answer sheet.");
      console.error(e);
    } finally {
      setBusy(null);
    }
  }

  // Bulk: every appeared student in the current section → one PDF each, zipped.
  async function exportAllStudentPdfs() {
    const targets = sectionRows.filter((r) => !r.absent);
    if (targets.length === 0) { alert("No appeared students to export in this section."); return; }
    const { generateStudentReport } = await import("../lib/pdf/student-report");
    const zip = new JSZip();
    setBulk({ done: 0, total: targets.length });
    let done = 0;
    const pool = 4;
    let idx = 0;
    async function worker() {
      while (idx < targets.length) {
        const row = targets[idx++];
        try {
          const d = await fetchStudentData(examId, row);
          const blob = await generateStudentReport({ brand, examTitle: exam.title, totalQuestions, ...d });
          zip.file(`${safeName(`${row.name} - ${row.rollNo}`)}.pdf`, blob);
        } catch (e) {
          console.error("skip", row.rollNo, e);
        }
        done++;
        setBulk({ done, total: targets.length });
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(pool, targets.length) }, worker));
      const out = await zip.generateAsync({ type: "blob" });
      saveBlob(out, `${fileBase} - Answer Sheets.zip`);
    } catch (e) {
      alert("Could not generate the answer-sheet ZIP.");
      console.error(e);
    } finally {
      setBulk(null);
    }
  }

  return (
    <div className="rise">
      <Link to="/reports" className="inline-flex items-center gap-1.5 text-sm text-[var(--color-ink2)] mb-3"><ArrowLeft size={16} /> Reports</Link>
      <PageHeader
        eyebrow="Assessment report"
        title={exam.title}
        action={
          <div className="flex items-center gap-2">
            <ExportMenu
              busy={busy}
              bulk={bulk}
              sectionLabel={sectionLabel}
              onCsv={exportCsv}
              onSectionPdf={exportSectionPdf}
              onAllPdfs={exportAllStudentPdfs}
            />
            <Pill label={exam.status.toUpperCase()} color="#2e7d5b" />
          </div>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
        {(() => {
          const setStat = (v: string) => { setStatFilter((prev) => (prev === v ? "all" : v)); setPage(1); };
          const cardCls = (active: boolean) =>
            `card p-5 text-left w-full transition ${active ? "ring-2 ring-[var(--color-brand)]" : "hover:border-[var(--color-brand)]"}`;
          return (
            <>
              <button type="button" onClick={() => setStat("all")} className={cardCls(statFilter === "all")}>
                <div className="stat-num text-[1.8rem]">{results.length}</div>
                <div className="mono-label mt-1">All students</div>
              </button>
              <button type="button" onClick={() => setStat("attempts")} className={cardCls(statFilter === "attempts")}>
                <div className="stat-num text-[1.8rem]">{results.filter((r) => !r.absent).length}</div>
                <div className="mono-label mt-1">Attempts</div>
              </button>
              <button type="button" onClick={() => setStat("absent")} className={cardCls(statFilter === "absent")}>
                <div className="stat-num text-[1.8rem]" style={{ color: "#c0453b" }}>{results.filter((r) => r.absent).length}</div>
                <div className="mono-label mt-1">Absent</div>
              </button>
              <div className="card p-5">
                <div className="stat-num text-[1.8rem]">{topper?.score ?? "—"}</div>
                <div className="mono-label mt-1">Highest score</div>
              </div>
            </>
          );
        })()}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="mono-label">Score</span>
        {BANDS.map((min) => {
          const active = statFilter === `b${min}`;
          return (
            <button
              key={min}
              type="button"
              onClick={() => { setStatFilter((prev) => (prev === `b${min}` ? "all" : `b${min}`)); setPage(1); }}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${active ? "bg-[var(--color-brand)] text-white border-[var(--color-brand)]" : "border-[var(--color-line)] text-[var(--color-ink2)] hover:border-[var(--color-brand)]"}`}
              title={`Students scoring ${min}% or above`}
            >
              ≥{min}% <span className={active ? "opacity-90" : "text-[var(--color-muted)]"}>· {bandCount(min)}</span>
            </button>
          );
        })}
      </div>

      {(sections.length > 0 || statFilter !== "all") && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {sections.length > 0 && (
            <>
              <span className="mono-label">Section</span>
              <button
                type="button"
                onClick={() => { setSectionFilter("all"); setPage(1); }}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${sectionFilter === "all" ? "bg-[var(--color-brand)] text-white border-[var(--color-brand)]" : "border-[var(--color-line)] text-[var(--color-ink2)] hover:border-[var(--color-brand)]"}`}
              >
                All
              </button>
              {sections.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => { setSectionFilter(s); setPage(1); }}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${sectionFilter === s ? "bg-[var(--color-brand)] text-white border-[var(--color-brand)]" : "border-[var(--color-line)] text-[var(--color-ink2)] hover:border-[var(--color-brand)]"}`}
                >
                  {s}
                </button>
              ))}
            </>
          )}
          {(statFilter !== "all" || sectionFilter !== "all") && (
            <button
              type="button"
              onClick={() => { setStatFilter("all"); setSectionFilter("all"); setPage(1); }}
              className="ml-auto text-xs text-[var(--color-muted)] underline"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {selected.size > 0 && (
        <div className="card flex items-center justify-between gap-3 px-4 py-3 mb-4" style={{ borderColor: "var(--color-brand)" }}>
          <div className="text-sm text-[var(--color-ink)]">
            <span className="font-semibold">{selected.size}</span> selected
            <button className="ml-3 text-xs text-[var(--color-muted)] underline" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
          <button
            className="btn"
            style={{ background: "#c0453b", color: "#fff" }}
            onClick={() => setBulkConfirm(true)}
          >
            <Trash2 size={16} /> Delete selected
          </button>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex items-center gap-3 sm:gap-4 px-3 sm:px-4 py-3 border-b border-[var(--color-line)]">
          <input
            type="checkbox"
            className="w-4 h-4 shrink-0 accent-[var(--color-brand)] cursor-pointer"
            checked={allSelected}
            ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected; }}
            onChange={toggleAll}
            title="Select all"
          />
          <span className="mono-label w-6 sm:w-8 shrink-0">#</span>
          <span className="mono-label flex-1 min-w-0">Student</span>
          <span className="mono-label w-32 shrink-0 hidden md:block">Roll No</span>
          <span className="mono-label w-20 shrink-0 hidden md:block">Section</span>
          <span className="mono-label w-28 text-right shrink-0 hidden sm:block">Submitted</span>
          <span className="mono-label w-14 sm:w-20 text-right shrink-0">Score</span>
          <span className="w-8 shrink-0" />
        </div>
        {pageResults.map((r, i) => (
          <div
            key={r.rollNo + i}
            onClick={() => { if (!r.absent) setOpenAttempt(r); }}
            className={`w-full flex items-center gap-3 sm:gap-4 px-3 sm:px-4 py-3 border-b border-[var(--color-line)] last:border-0 text-left transition ${selected.has(r.studentId) ? "bg-[var(--color-brand-soft)]" : ""} ${r.absent ? "" : "cursor-pointer hover:bg-[var(--color-brand-soft)]"}`}
          >
            <input
              type="checkbox"
              className="w-4 h-4 shrink-0 accent-[var(--color-brand)] cursor-pointer"
              checked={selected.has(r.studentId)}
              onClick={(e) => e.stopPropagation()}
              onChange={() => toggleOne(r.studentId)}
              title="Select student"
            />
            <span className="mono-label w-6 sm:w-8 shrink-0">{String((curPage - 1) * PS + i + 1).padStart(2, "0")}</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-[var(--color-ink)] truncate flex items-center gap-2">
                {r.name}
                {r.disconnected && (
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded" style={{ color: "#b7791f", background: "rgba(183,121,31,.12)", fontFamily: "var(--font-mono)" }} title="Lost connection before submitting — only synced answers were graded">
                    Disconnected · {r.answeredCount ?? 0}/{totalQuestions ?? "—"}
                  </span>
                )}
              </div>
              <div className="text-xs text-[var(--color-muted)] truncate md:hidden" style={{ fontFamily: "var(--font-mono)" }}>{r.rollNo}{r.section ? ` · ${r.section}` : ""}</div>
            </div>
            <span className="w-32 shrink-0 hidden md:block text-sm text-[var(--color-ink2)] truncate" style={{ fontFamily: "var(--font-mono)" }}>{r.rollNo}</span>
            <span className="w-20 shrink-0 hidden md:block text-sm text-[var(--color-ink2)] truncate" style={{ fontFamily: "var(--font-mono)" }}>{r.section || "—"}</span>
            <span className="w-28 text-right shrink-0 hidden sm:block text-xs text-[var(--color-muted)]" style={{ fontFamily: "var(--font-mono)" }}>{fmtSubmitted(r.submittedAt)}</span>
            {r.absent ? (
              <span className="stat-num w-14 sm:w-20 text-right shrink-0" style={{ color: "#c0453b" }} title="Absent">A</span>
            ) : r.status === "graded" ? (
              <span className="stat-num w-14 sm:w-20 text-right shrink-0 text-[var(--color-ink)]">{r.score ?? "—"}</span>
            ) : (
              <span className="w-14 sm:w-20 text-right shrink-0 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "#b7791f", fontFamily: "var(--font-mono)" }}>Grading</span>
            )}
            <RowActions
              absent={!!r.absent}
              downloading={busy === `one:${r.attemptId}`}
              onDownload={() => exportStudentPdf(r)}
              onMarkAbsent={() => setConfirm({ row: r, action: "absent" })}
              onRemove={() => setConfirm({ row: r, action: "remove" })}
            />
          </div>
        ))}
        {pageResults.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-[var(--color-muted)]">No students match the current filters.</div>
        )}
      </div>

      <Pager page={curPage} pageCount={pageCount} from={from} to={to} total={filtered.length} onChange={setPage} unit="students" />

      {bulkConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(15,20,30,.45)" }} onClick={() => !bulkRemove.isPending && setBulkConfirm(false)}>
          <div className="card p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="text-lg font-semibold text-[var(--color-ink)] mb-1">Delete {selected.size} student{selected.size > 1 ? "s" : ""}?</div>
            <p className="text-sm text-[var(--color-ink2)] leading-relaxed mb-5">
              The selected students will be removed from this assessment. Any attempts and answers they submitted will be deleted and they will no longer appear on the report. This cannot be undone from here.
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setBulkConfirm(false)} disabled={bulkRemove.isPending}>Cancel</button>
              <button className="btn" style={{ background: "#c0453b", color: "#fff" }} onClick={() => bulkRemove.mutate([...selected])} disabled={bulkRemove.isPending}>
                {bulkRemove.isPending ? "Deleting…" : `Delete ${selected.size}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {openAttempt && <AttemptDrawer examId={examId} row={openAttempt} brand={brand} examTitle={exam.title} totalQuestions={totalQuestions} onClose={() => setOpenAttempt(null)} />}

      {confirm && (
        <ConfirmDialog
          row={confirm.row}
          action={confirm.action}
          busy={markAbsent.isPending || removeStudent.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            if (confirm.action === "absent") markAbsent.mutate(confirm.row.studentId);
            else removeStudent.mutate(confirm.row.studentId);
          }}
        />
      )}
    </div>
  );
}

function ExportMenu({ busy, bulk, sectionLabel, onCsv, onSectionPdf, onAllPdfs }: {
  busy: string | null;
  bulk: { done: number; total: number } | null;
  sectionLabel: string;
  onCsv: () => void;
  onSectionPdf: () => void;
  onAllPdfs: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const anyBusy = busy === "section" || !!bulk;
  const run = (fn: () => void) => { setOpen(false); fn(); };
  const Item = ({ icon: Icon, title, sub, onClick }: { icon: typeof FileText; title: string; sub: string; onClick: () => void }) => (
    <button className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-[var(--color-brand-soft)]" onClick={onClick}>
      <Icon size={16} className="mt-0.5 text-[var(--brand)] shrink-0" />
      <div className="min-w-0">
        <div className="text-sm font-medium text-[var(--color-ink)]">{title}</div>
        <div className="text-xs text-[var(--color-muted)] leading-snug">{sub}</div>
      </div>
    </button>
  );
  return (
    <div ref={ref} className="relative">
      <button className="btn btn-ghost" onClick={() => setOpen((v) => !v)} disabled={anyBusy}>
        {anyBusy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
        {bulk ? `Zipping ${bulk.done}/${bulk.total}` : busy === "section" ? "Building PDF…" : "Download"}
        {!anyBusy && <ChevronDown size={15} />}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-30 w-72 rounded-xl border border-[var(--color-line)] bg-white shadow-lg py-1.5" style={{ boxShadow: "0 10px 34px rgba(0,0,0,.14)" }}>
          <div className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]" style={{ fontFamily: "var(--font-mono)" }}>{sectionLabel}</div>
          <Item icon={FileText} title="Section report (PDF)" sub="Stats, graphs, top performers & full list" onClick={() => run(onSectionPdf)} />
          <Item icon={FileSpreadsheet} title="Section report (CSV)" sub="Ranked marks sheet for Excel" onClick={() => run(onCsv)} />
          <div className="my-1 border-t border-[var(--color-line)]" />
          <Item icon={Files} title="All answer sheets (ZIP)" sub="One PDF per appeared student, with answers & explanations" onClick={() => run(onAllPdfs)} />
        </div>
      )}
    </div>
  );
}

function RowActions({ absent, downloading, onDownload, onMarkAbsent, onRemove }: { absent: boolean; downloading: boolean; onDownload: () => void; onMarkAbsent: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} className="relative w-8 shrink-0 flex justify-end" onClick={(e) => e.stopPropagation()}>
      <button
        className="p-1.5 rounded-md hover:bg-[var(--color-line)] text-[var(--color-muted)]"
        onClick={() => setOpen((v) => !v)}
        title="Roster actions"
      >
        {downloading ? <Loader2 size={16} className="animate-spin" /> : <MoreVertical size={16} />}
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-20 w-52 rounded-lg border border-[var(--color-line)] bg-white shadow-lg py-1" style={{ boxShadow: "0 8px 28px rgba(0,0,0,.12)" }}>
          {!absent && (
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-ink)] hover:bg-[var(--color-brand-soft)] text-left"
              onClick={() => { setOpen(false); onDownload(); }}
            >
              <FileText size={15} /> Download answer sheet
            </button>
          )}
          {!absent && (
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-ink)] hover:bg-[var(--color-brand-soft)] text-left"
              onClick={() => { setOpen(false); onMarkAbsent(); }}
            >
              <UserX size={15} /> Mark as absent
            </button>
          )}
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-[#fbeceb]"
            style={{ color: "#c0453b" }}
            onClick={() => { setOpen(false); onRemove(); }}
          >
            <Trash2 size={15} /> Remove from assessment
          </button>
        </div>
      )}
    </div>
  );
}

function ConfirmDialog({ row, action, busy, onCancel, onConfirm }: { row: Row; action: "absent" | "remove"; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const isRemove = action === "remove";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(15,20,30,.45)" }} onClick={onCancel}>
      <div className="card p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="text-lg font-semibold text-[var(--color-ink)] mb-1">
          {isRemove ? "Remove from assessment?" : "Mark student absent?"}
        </div>
        <p className="text-sm text-[var(--color-ink2)] leading-relaxed mb-5">
          {isRemove ? (
            <><span className="font-medium text-[var(--color-ink)]">{row.name}</span> ({row.rollNo}) will be removed from this assessment. Any attempt and answers they submitted will be deleted and they will no longer appear on the report.</>
          ) : (
            <><span className="font-medium text-[var(--color-ink)]">{row.name}</span> ({row.rollNo}) will be marked absent. Any submitted attempt will be cleared and they will show as “A” on the report.</>
          )}
        </p>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn"
            style={{ background: isRemove ? "#c0453b" : "#b7791f", color: "#fff" }}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : isRemove ? "Remove" : "Mark absent"}
          </button>
        </div>
      </div>
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

function AttemptDrawer({ examId, row, brand, examTitle, totalQuestions, onClose }: { examId: string; row: Row; brand: Brand; examTitle: string; totalQuestions?: number; onClose: () => void }) {
  const [dl, setDl] = useState(false);
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

  async function download() {
    if (!d) return;
    setDl(true);
    try {
      const { generateStudentReport } = await import("../lib/pdf/student-report");
      const blob = await generateStudentReport({
        brand,
        examTitle,
        totalQuestions,
        student: { name: d.student.name, rollNo: d.student.rollNo, email: d.student.email, section: row.section },
        attempt: { score: d.attempt.score, status: d.attempt.status, submittedAt: d.attempt.submittedAt },
        answers: d.answers as StudentAnswer[],
      });
      saveBlob(blob, `${safeName(`${row.name} - ${row.rollNo}`)}.pdf`);
    } catch (e) {
      alert("Could not generate the answer sheet PDF.");
      console.error(e);
    } finally {
      setDl(false);
    }
  }

  return (
    <Drawer eyebrow="Student report" title={row.name} subtitle={`${row.rollNo}${row.email ? " · " + row.email : ""}`} onClose={onClose} width="max-w-3xl">
      <button
        className="btn btn-ghost w-full mb-5 justify-center border border-[var(--color-line)]"
        onClick={download}
        disabled={!d || dl}
      >
        {dl ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />} {dl ? "Preparing PDF…" : "Download answer sheet (PDF)"}
      </button>
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
