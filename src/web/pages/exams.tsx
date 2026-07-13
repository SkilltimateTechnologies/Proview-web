import { useState, useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Lock, BarChart3, Clock, CalendarClock, ArrowLeft, Pencil, Ban, Search, UserPlus, UserX, Undo2, Users } from "lucide-react";
import { useLocation, useParams } from "wouter";
import { api } from "../lib/api";
import { PageHeader } from "../components/shell";
import { Loader, EmptyState, Pill, Field, usePagination, Pager, Drawer } from "../components/ui";

function toMs(ts: number | string | null | undefined): number | null {
  if (ts === null || ts === undefined) return null;
  const n = typeof ts === "number" ? ts : new Date(ts).getTime();
  return Number.isFinite(n) ? n : null;
}
function timeUntil(ts: number | string | null | undefined): string {
  const ms = toMs(ts);
  if (!ms) return "Not scheduled";
  const diff = ms - Date.now();
  if (diff <= 0) return "Starting now";
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (d > 0) return `Starts in ${d}d ${h}h`;
  if (h > 0) return `Starts in ${h}h ${m}m`;
  return `Starts in ${m}m`;
}
function fmtDate(ts: number | string | null | undefined): string {
  const ms = toMs(ts);
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}
// Timestamp -> value for <input type="datetime-local"> (local wall-clock, no seconds).
function toLocalInput(ts: number | string | null | undefined): string {
  const ms = toMs(ts);
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Combine a date (YYYY-MM-DD) + slot (HH:mm) into an IST wall-clock ISO string
// that carries the +05:30 offset so the server stores the correct instant.
function combineIST(dateStr: string, slot: string): number | null {
  if (!dateStr || !slot) return null;
  const iso = `${dateStr}T${slot}:00+05:30`;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}
// Split a stored timestamp back into an IST date + slot for editing.
function splitIST(ts: number | string | null | undefined): { date: string; slot: string } {
  const ms = toMs(ts);
  if (!ms) return { date: "", slot: "" };
  // Render the instant in IST, then read off the parts.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hh = g("hour");
  if (hh === "24") hh = "00";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, slot: `${hh}:${g("minute")}` };
}

type ExamRow = { id: string; title: string; status: string; startAt: number | string | null; endAt?: number | string | null; extraMin?: number | null; holdMs?: number | null; heldAt?: number | string | null; durationMin: number; totalPoints: number; sectionIds?: string[] | null };

const STATUS_COLOR: Record<string, string> = { finished: "#2e7d5b", live: "#c0453b", scheduled: "#b7791f", draft: "#8a929c", ended: "#5b6472" };

// An exam window is fully closed once endAt (+ any admin extra time + total hold
// time) has elapsed. A currently-held exam is paused, not over.
function isOver(e: { endAt?: number | string | null; extraMin?: number | null; holdMs?: number | null; heldAt?: number | string | null }): boolean {
  if (e.heldAt) return false;
  const end = toMs(e.endAt ?? null);
  if (end === null) return false;
  const extra = (e.extraMin ?? 0) * 60_000 + (e.holdMs ?? 0);
  return Date.now() > end + extra;
}

// A scheduled assessment becomes LIVE automatically once its start time passes
// (students can already start it at that point). Once its window closes it is
// no longer live — it has ENDED — so it must stop showing "In progress".
function displayStatus(e: { status: string; startAt: number | string | null; endAt?: number | string | null; extraMin?: number | null; holdMs?: number | null; heldAt?: number | string | null }): string {
  if (e.status === "draft" || e.status === "finished") return e.status;
  if (isOver(e)) return "ended";
  if (e.status === "live") return "live";
  if (e.status === "scheduled") {
    const ms = toMs(e.startAt);
    if (ms !== null && Date.now() >= ms) return "live";
  }
  return e.status;
}

type PickQ = { id: string; prompt: string; points: number; type: string; topic?: string | null; categoryName?: string | null; difficulty?: string };
const Q_TYPE_LABEL: Record<string, string> = {
  mcq: "MCQ", multi: "Multi", truefalse: "T/F", fillblank: "Fill", short: "Short", essay: "Essay", coding: "Coding",
};

export default function Exams() {
  const [, navigate] = useLocation();

  const exams = useQuery({
    queryKey: ["exams"],
    queryFn: async () => (await api.exams.$get()).json(),
  });

  const examList = exams.data?.exams ?? [];
  const pg = usePagination(examList);

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Assessments"
        title="Schedule Assessment"
        action={<button className="btn btn-primary" onClick={() => navigate("/exams/new")}><Plus size={16} /> New assessment</button>}
      />

      {exams.isLoading ? (
        <Loader />
      ) : !exams.data?.exams.length ? (
        <EmptyState title="No assessments yet" hint="Create your first assessment to schedule an exam." />
      ) : (
        <div className="space-y-3">
          {pg.pageItems.map((e) => {
            const ds = displayStatus(e);
            return (
            <div key={e.id} className="card p-4 flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="font-medium text-[var(--color-ink)]">{e.title}</div>
                <div className="mono-label mt-1 flex items-center gap-2 flex-wrap">
                  <span>{e.durationMin} min · {e.totalPoints} pts</span>
                  {e.startAt && ds !== "scheduled" && (
                    <span className="inline-flex items-center gap-1">
                      <CalendarClock size={13} /> {fmtDate(e.startAt)}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <Pill label={ds.toUpperCase()} color={STATUS_COLOR[ds]} />
                {ds === "scheduled" && (
                  <span className="inline-flex items-center gap-1.5 text-sm text-[var(--color-ink2)]">
                    <CalendarClock size={14} /> {fmtDate(e.startAt)}
                    <span className="mono-label" style={{ color: "var(--brand)" }}>· {timeUntil(e.startAt)}</span>
                  </span>
                )}
                {ds === "live" && (
                  <span className="inline-flex items-center gap-1.5 text-sm" style={{ color: "#c0453b" }}>
                    <Clock size={14} /> In progress
                  </span>
                )}
                {ds === "ended" && (
                  <span className="inline-flex items-center gap-1.5 text-sm text-[var(--color-ink2)]">
                    <Clock size={14} /> Ended{e.startAt ? ` · ${fmtDate(e.startAt)}` : ""}
                  </span>
                )}
                {(ds === "scheduled" || ds === "live" || e.status === "draft") && (
                  <button className="btn btn-ghost py-1.5 text-sm" onClick={() => navigate(`/exams/${e.id}/edit`)}>
                    <Pencil size={15} /> {e.status === "draft" ? "Edit & schedule" : "Edit"}
                  </button>
                )}
                {e.status === "finished" || ds === "ended" ? (
                  <button className="btn btn-primary py-1.5 text-sm" onClick={() => navigate(`/reports/${e.id}`)}>
                    <BarChart3 size={15} /> Reports
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs text-[var(--color-muted)] mono-label">
                    <Lock size={12} /> Reports after finish
                  </span>
                )}
              </div>
            </div>
            );
          })}
          <Pager {...pg} onChange={pg.setPage} unit="assessments" />
        </div>
      )}
    </div>
  );
}

export function EditExam() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const params = useParams();
  const examId = params.id as string;

  const examQ = useQuery({
    queryKey: ["exam", examId],
    queryFn: async () => (await api.exams[":id"].$get({ param: { id: examId } })).json(),
  });
  const classes = useQuery({ queryKey: ["classes"], queryFn: async () => (await api.classes.$get()).json() });
  const questions = useQuery({ queryKey: ["questions-pick"], queryFn: async () => (await api.questions.$get()).json() });
  const sections = (classes.data?.classes ?? []) as Array<{ id: string; code: string }>;
  const qList = (questions.data?.questions ?? []) as PickQ[];

  const exam = (examQ.data && "exam" in examQ.data ? examQ.data.exam : null) as (ExamRow & { assignMode?: string | null }) | null;
  const initialQIds = (examQ.data && "questionIds" in examQ.data ? examQ.data.questionIds : []) as string[];
  const initialStudentIds = (examQ.data && "studentIds" in examQ.data ? (examQ.data as { studentIds: string[] }).studentIds : []) as string[];

  const [title, setTitle] = useState("");
  const [durationMin, setDurationMin] = useState(60);
  const [date, setDate] = useState("");
  const [slot, setSlot] = useState("");
  const [scope, setScope] = useState<"all" | "specific" | "students">("all");
  const [sectionIds, setSectionIds] = useState<string[]>([]);
  const [studentIds, setStudentIds] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate the form once the exam loads.
  if (exam && !hydrated) {
    const initial = splitIST(exam.startAt);
    setTitle(exam.title);
    setDurationMin(exam.durationMin);
    setDate(initial.date);
    setSlot(initial.slot);
    setScope(exam.assignMode === "students" ? "students" : (exam.sectionIds && exam.sectionIds.length ? "specific" : "all"));
    setSectionIds(exam.sectionIds ?? []);
    setStudentIds(initialStudentIds);
    setPicked(initialQIds);
    setHydrated(true);
  }

  const scopeValid = scope === "all" || (scope === "specific" && sectionIds.length > 0) || (scope === "students" && studentIds.length > 0);
  function toggleSection(sid: string) {
    setSectionIds((p) => (p.includes(sid) ? p.filter((x) => x !== sid) : [...p, sid]));
  }

  const done = () => {
    qc.invalidateQueries({ queryKey: ["exams"] });
    qc.invalidateQueries({ queryKey: ["exam", examId] });
    navigate("/exams");
  };

  const save = useMutation({
    mutationFn: async () => {
      const startAt = combineIST(date, slot);
      return (await api.exams[":id"].$patch({
        param: { id: examId },
        // A start time means the assessment is scheduled; no start time keeps it a draft.
        json: {
          title,
          durationMin,
          startAt,
          assignMode: scope === "students" ? "students" : "cohort",
          sectionIds: scope === "specific" ? sectionIds : [],
          studentIds: scope === "students" ? studentIds : [],
          questionIds: picked,
          status: startAt ? "scheduled" : "draft",
        },
      })).json();
    },
    onSuccess: done,
  });

  const cancelExam = useMutation({
    mutationFn: async () =>
      (await api.exams[":id"].$patch({
        param: { id: examId },
        json: { status: "draft", startAt: null },
      })).json(),
    onSuccess: done,
  });

  if (examQ.isLoading || !exam) {
    return (
      <div className="rise">
        <button className="btn btn-ghost mb-3 -ml-2" onClick={() => navigate("/exams")}>
          <ArrowLeft size={16} /> Back to assessments
        </button>
        {examQ.isLoading ? <Loader /> : <EmptyState title="Assessment not found" hint="It may have been removed." />}
      </div>
    );
  }

  const isDraft = exam.status === "draft";
  const scheduled = Boolean(date && slot);
  const total = qList.filter((q) => picked.includes(q.id)).reduce((s, q) => s + q.points, 0);

  return (
    <div className="rise">
      <button className="btn btn-ghost mb-3 -ml-2" onClick={() => navigate("/exams")}>
        <ArrowLeft size={16} /> Back to assessments
      </button>
      <PageHeader eyebrow="Assessment" title={isDraft ? "Edit & schedule assessment" : "Edit assessment"} />

      <div className="card p-5">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Duration (min)"><input className="input" type="number" value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))} /></Field>
          <Field label="Start date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Time (IST)">
            <input type="time" className="input" value={slot} onChange={(e) => setSlot(e.target.value)} />
          </Field>
        </div>
        {scheduled && (
          <p className="mt-3 text-xs text-[var(--color-ink2)]">
            <Lock size={11} className="inline -mt-0.5 mr-1" />
            The exam window closes 2 hours after the start time. Students who don't start by then are marked absent.
          </p>
        )}
        {isDraft && !scheduled && (
          <p className="mt-3 text-xs text-[var(--color-ink2)]">
            Set a start date &amp; time slot to schedule this assessment. Leave it empty to keep it as a draft.
          </p>
        )}

        {/* Assign scope */}
        <div className="mt-4">
          <div className="mono-label mb-2">Assign to</div>
          <div className="flex gap-2 mb-3 flex-wrap">
            <button className={`btn ${scope === "all" ? "btn-primary" : "btn-ghost"}`} onClick={() => setScope("all")}>All sections</button>
            <button className={`btn ${scope === "specific" ? "btn-primary" : "btn-ghost"}`} onClick={() => setScope("specific")}>Specific sections</button>
            <button className={`btn ${scope === "students" ? "btn-primary" : "btn-ghost"}`} onClick={() => setScope("students")}>Specific students</button>
          </div>
          {scope === "specific" && (
            <div className="flex flex-wrap gap-2">
              {sections.length === 0 && <div className="text-sm text-[var(--color-ink2)]">No sections yet. Add classes in Users.</div>}
              {sections.map((s) => {
                const on = sectionIds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => toggleSection(s.id)}
                    className={`rounded-lg border px-3 py-1.5 text-sm transition ${on ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)] font-medium" : "border-[var(--color-line)] text-[var(--color-ink)]"}`}
                  >
                    {s.code}
                  </button>
                );
              })}
            </div>
          )}
          {scope === "students" && <StudentPicker selected={studentIds} setSelected={setStudentIds} />}
        </div>

        {questions.isLoading ? (
          <div className="mt-5"><Loader /></div>
        ) : (
          <QuestionPicker questions={qList} picked={picked} setPicked={setPicked} total={total} />
        )}

        <div className="flex items-center gap-2 mt-5">
          <button className="btn btn-primary" disabled={save.isPending || !title.trim() || picked.length === 0 || !scopeValid} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : isDraft ? (scheduled ? "Save & schedule" : "Save draft") : "Save changes"}
          </button>
          <button className="btn btn-ghost" onClick={() => navigate("/exams")}>Cancel</button>
        </div>

        {!isDraft && (
          <div className="mt-5 pt-4 border-t border-[var(--color-line)]">
            <div className="mono-label mb-2">Cancel assessment</div>
            <p className="text-sm text-[var(--color-ink2)] mb-3">
              Stop this scheduled assessment. It will be unscheduled and moved back to draft so students can no longer start it.
            </p>
            <button
              className="btn py-1.5 text-sm"
              style={{ background: "#fbecea", color: "#c0453b" }}
              disabled={cancelExam.isPending}
              onClick={() => { if (confirm("Cancel this scheduled assessment? It will be unscheduled.")) cancelExam.mutate(); }}
            >
              <Ban size={15} /> {cancelExam.isPending ? "Cancelling…" : "Stop & unschedule"}
            </button>
          </div>
        )}
      </div>

      {scope !== "students" && <RosterPanel examId={examId} />}
    </div>
  );
}

type RCand = { id: string; name: string; rollNo: string; email: string | null; section: string };

// Per-assessment roster overrides shown on the Schedule Assessment screen.
// Admins can add a specific student onto this assessment or remove one from it,
// independent of the section cohort. Works even after the exam window closes.
function RosterPanel({ examId }: { examId: string }) {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  const rosterQ = useQuery({
    queryKey: ["exam-roster", examId],
    queryFn: async () => {
      const res = await api.exams[":examId"].roster.$get({ param: { examId } });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
  });
  const added = (rosterQ.data && !("message" in rosterQ.data) ? rosterQ.data.added : []) as RCand[];
  const removed = (rosterQ.data && !("message" in rosterQ.data) ? rosterQ.data.removed : []) as RCand[];

  const refresh = () => qc.invalidateQueries({ queryKey: ["exam-roster", examId] });

  const reset = useMutation({
    mutationFn: async (studentId: string) => {
      const res = await api.exams[":examId"].roster.reset.$post({ param: { examId }, json: { studentId } });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
    onSuccess: refresh,
  });

  return (
    <div className="card p-5 mt-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="mono-label mb-1">Roster overrides</div>
          <p className="text-sm text-[var(--color-ink2)]">
            Add a specific student onto this assessment, or remove one from it — beyond the section cohort.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-ghost" onClick={() => setAddOpen(true)}><UserPlus size={16} /> Add student</button>
          <button className="btn btn-ghost" onClick={() => setRemoveOpen(true)}><UserX size={16} /> Remove student</button>
        </div>
      </div>

      {rosterQ.isLoading ? (
        <div className="mt-4"><Loader /></div>
      ) : (added.length === 0 && removed.length === 0) ? (
        <div className="mt-4 text-sm text-[var(--color-ink2)] flex items-center gap-2">
          <Users size={15} /> No overrides. This assessment uses the section cohort only.
        </div>
      ) : (
        <div className="mt-4 grid sm:grid-cols-2 gap-4">
          <div>
            <div className="mono-label mb-2" style={{ color: "#2e7d5b" }}>Added ({added.length})</div>
            {added.length === 0 ? (
              <div className="text-sm text-[var(--color-ink2)]">None</div>
            ) : (
              <div className="space-y-2">
                {added.map((s) => (
                  <RosterRow key={s.id} s={s} onUndo={() => reset.mutate(s.id)} undoing={reset.isPending} label="Remove" />
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="mono-label mb-2" style={{ color: "#c0453b" }}>Removed ({removed.length})</div>
            {removed.length === 0 ? (
              <div className="text-sm text-[var(--color-ink2)]">None</div>
            ) : (
              <div className="space-y-2">
                {removed.map((s) => (
                  <RosterRow key={s.id} s={s} onUndo={() => reset.mutate(s.id)} undoing={reset.isPending} label="Restore" />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {addOpen && <RosterPickDrawer examId={examId} mode="add" onClose={() => setAddOpen(false)} onDone={refresh} />}
      {removeOpen && <RosterPickDrawer examId={examId} mode="remove" onClose={() => setRemoveOpen(false)} onDone={refresh} />}
    </div>
  );
}

function RosterRow({ s, onUndo, undoing, label }: { s: RCand; onUndo: () => void; undoing: boolean; label: string }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-[var(--color-line)]">
      <div className="flex-1 min-w-0">
        <div className="font-medium text-[var(--color-ink)] truncate text-sm">{s.name}</div>
        <div className="text-xs text-[var(--color-muted)] truncate" style={{ fontFamily: "var(--font-mono)" }}>{s.rollNo}{s.section ? ` · ${s.section}` : ""}</div>
      </div>
      <button className="btn btn-ghost shrink-0 py-1 text-xs" onClick={onUndo} disabled={undoing}>
        <Undo2 size={14} /> {label}
      </button>
    </div>
  );
}

// Search + pick drawer, reused for both "add" (searches non-eligible candidates)
// and "remove" (searches currently-eligible students).
function RosterPickDrawer({ examId, mode, onClose, onDone }: { examId: string; mode: "add" | "remove"; onClose: () => void; onDone: () => void }) {
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term), 250);
    return () => clearTimeout(t);
  }, [term]);

  const q = useQuery({
    queryKey: ["roster-pick", examId, mode, debounced],
    queryFn: async () => {
      const res = mode === "add"
        ? await api.exams[":examId"].roster.candidates.$get({ param: { examId }, query: { q: debounced } })
        : await api.exams[":examId"].roster.eligible.$get({ param: { examId }, query: { q: debounced } });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
  });
  const rows = (q.data && !("message" in q.data)
    ? (mode === "add" ? (q.data as { candidates: RCand[] }).candidates : (q.data as { eligible: RCand[] }).eligible)
    : []) as RCand[];

  const act = useMutation({
    mutationFn: async (studentId: string) => {
      setBusyId(studentId);
      const res = mode === "add"
        ? await api.exams[":examId"].roster.add.$post({ param: { examId }, json: { studentId } })
        : await api.exams[":examId"].roster.remove.$post({ param: { examId }, json: { studentId } });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
    onSuccess: () => { onDone(); q.refetch(); },
    onSettled: () => setBusyId(null),
  });

  const isAdd = mode === "add";
  return (
    <Drawer
      eyebrow="Roster"
      title={isAdd ? "Add student to assessment" : "Remove student from assessment"}
      subtitle={isAdd ? "Search any student to add onto this assessment" : "Search students currently eligible for this assessment"}
      onClose={onClose}
      width="max-w-lg"
    >
      <div className="relative mb-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)]" />
        <input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search by name, roll no, or email"
          className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-[var(--color-line)] text-sm bg-white text-[var(--color-ink)]"
        />
      </div>
      {isAdd ? null : (
        <p className="text-xs text-[var(--color-ink2)] mb-3">
          Removing a student excludes them from the roster, report and count, and deletes any attempt they had for this assessment.
        </p>
      )}
      {q.isLoading ? (
        <Loader />
      ) : rows.length === 0 ? (
        <div className="card p-6 text-center text-sm text-[var(--color-ink2)]">
          {debounced
            ? "No matching students."
            : isAdd ? "Start typing to find students to add." : "Start typing to find students to remove."}
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--color-line)]">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-[var(--color-ink)] truncate">{s.name}</div>
                <div className="text-xs text-[var(--color-muted)] truncate" style={{ fontFamily: "var(--font-mono)" }}>{s.rollNo}{s.section ? ` · ${s.section}` : ""}{s.email ? ` · ${s.email}` : ""}</div>
              </div>
              <button
                className="btn btn-ghost shrink-0"
                onClick={() => act.mutate(s.id)}
                disabled={busyId === s.id}
              >
                {isAdd ? <UserPlus size={15} /> : <UserX size={15} />}
                {busyId === s.id ? "Working…" : isAdd ? "Add" : "Remove"}
              </button>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}

// Searchable multi-select of individual students, for "Specific students" scope.
type StudentLite = { id: string; name: string | null; rollNo: string | null; email: string | null; classId: string | null };
function StudentPicker({ selected, setSelected }: { selected: string[]; setSelected: Dispatch<SetStateAction<string[]>> }) {
  const [term, setTerm] = useState("");
  const studentsQ = useQuery({ queryKey: ["students-pick"], queryFn: async () => (await api.students.$get()).json() });
  const classesQ = useQuery({ queryKey: ["classes"], queryFn: async () => (await api.classes.$get()).json() });
  const students = ((studentsQ.data as { students?: StudentLite[] })?.students ?? []).filter((s) => (s as unknown as { enabled?: boolean }).enabled !== false);
  const classes = ((classesQ.data as { classes?: Array<{ id: string; code: string }> })?.classes ?? []);
  const clmap = new Map(classes.map((c) => [c.id, c.code]));
  const sel = new Set(selected);

  const q = term.trim().toLowerCase();
  const filtered = students.filter((s) =>
    !q || (s.name ?? "").toLowerCase().includes(q) || (s.rollNo ?? "").toLowerCase().includes(q) || (s.email ?? "").toLowerCase().includes(q),
  );
  const shown = filtered.slice(0, 100);

  const toggle = (sid: string) => setSelected((p) => (p.includes(sid) ? p.filter((x) => x !== sid) : [...p, sid]));
  const allShownSelected = shown.length > 0 && shown.every((s) => sel.has(s.id));
  const toggleAllShown = () =>
    setSelected((p) => {
      const ids = shown.map((s) => s.id);
      return ids.every((i) => p.includes(i)) ? p.filter((i) => !ids.includes(i)) : [...new Set([...p, ...ids])];
    });

  return (
    <div>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)]" />
          <input className="input pl-9" placeholder="Search students by name, roll no, email…" value={term} onChange={(e) => setTerm(e.target.value)} />
        </div>
        <span className="mono-label">{selected.length} selected</span>
        {selected.length > 0 && (
          <button className="text-xs text-[var(--color-muted)] underline" onClick={() => setSelected([])}>Clear</button>
        )}
      </div>
      {studentsQ.isLoading ? (
        <Loader />
      ) : students.length === 0 ? (
        <div className="text-sm text-[var(--color-ink2)]">No students yet. Add students in Users.</div>
      ) : (
        <div className="rounded-lg border border-[var(--color-line)] overflow-hidden">
          <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--color-line)] bg-[var(--color-brand-soft)]">
            <input type="checkbox" className="w-4 h-4 accent-[var(--color-brand)] cursor-pointer" checked={allShownSelected} onChange={toggleAllShown} title="Select all shown" />
            <span className="mono-label flex-1">{filtered.length} shown{filtered.length > shown.length ? ` (first ${shown.length})` : ""}</span>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {shown.map((s) => {
              const on = sel.has(s.id);
              return (
                <label key={s.id} className={`flex items-center gap-3 px-3 py-2 border-b border-[var(--color-line)] last:border-0 cursor-pointer transition ${on ? "bg-[var(--color-brand-soft)]" : "hover:bg-[var(--color-brand-soft)]"}`}>
                  <input type="checkbox" className="w-4 h-4 accent-[var(--color-brand)] cursor-pointer" checked={on} onChange={() => toggle(s.id)} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[var(--color-ink)] truncate text-sm">{s.name ?? "—"}</div>
                    <div className="text-xs text-[var(--color-muted)] truncate" style={{ fontFamily: "var(--font-mono)" }}>
                      {s.rollNo}{s.classId && clmap.get(s.classId) ? ` · ${clmap.get(s.classId)}` : ""}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function NewExam() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const classes = useQuery({ queryKey: ["classes"], queryFn: async () => (await api.classes.$get()).json() });
  const questions = useQuery({ queryKey: ["questions-pick"], queryFn: async () => (await api.questions.$get()).json() });
  const sections = (classes.data?.classes ?? []) as Array<{ id: string; code: string }>;
  const qList = (questions.data?.questions ?? []) as PickQ[];

  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<"all" | "specific" | "students">("all");
  const [sectionIds, setSectionIds] = useState<string[]>([]);
  const [studentIds, setStudentIds] = useState<string[]>([]);
  const [durationMin, setDurationMin] = useState(60);
  const [date, setDate] = useState("");
  const [slot, setSlot] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  const scopeValid = scope === "all" || (scope === "specific" && sectionIds.length > 0) || (scope === "students" && studentIds.length > 0);

  function goBack() {
    navigate("/exams");
  }

  const create = useMutation({
    mutationFn: async () => {
      const startAt = combineIST(date, slot) ?? undefined;
      const res = await api.exams.$post({
        json: {
          title,
          assignMode: scope === "students" ? "students" : "cohort",
          sectionIds: scope === "specific" ? sectionIds : undefined,
          studentIds: scope === "students" ? studentIds : undefined,
          durationMin,
          questionIds: picked,
          startAt,
          // No start time = keep it as a draft; a time means it's scheduled.
          status: startAt ? "scheduled" : "draft",
        },
      });
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["exams"] });
      goBack();
    },
  });

  const total = qList.filter((q) => picked.includes(q.id)).reduce((s, q) => s + q.points, 0);

  function toggleSection(sid: string) {
    setSectionIds((p) => (p.includes(sid) ? p.filter((x) => x !== sid) : [...p, sid]));
  }

  return (
    <div className="rise">
      <button className="btn btn-ghost mb-3 -ml-2" onClick={goBack}>
        <ArrowLeft size={16} /> Back to assessments
      </button>
      <PageHeader eyebrow="Assessments" title="New assessment" />

      <div className="card p-5">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Mid-Sem Test" /></Field>
          <Field label="Duration (min)"><input className="input" type="number" value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))} /></Field>
          <Field label="Start date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Time (IST)">
            <input type="time" className="input" value={slot} onChange={(e) => setSlot(e.target.value)} />
          </Field>
        </div>
        {date && slot && (
          <p className="mt-3 text-xs text-[var(--color-ink2)]">
            <Lock size={11} className="inline -mt-0.5 mr-1" />
            The exam window closes 2 hours after the start time. Students who don't start by then are marked absent.
          </p>
        )}

        {/* Assign scope */}
        <div className="mt-4">
          <div className="mono-label mb-2">Assign to</div>
          <div className="flex gap-2 mb-3 flex-wrap">
            <button className={`btn ${scope === "all" ? "btn-primary" : "btn-ghost"}`} onClick={() => setScope("all")}>All sections</button>
            <button className={`btn ${scope === "specific" ? "btn-primary" : "btn-ghost"}`} onClick={() => setScope("specific")}>Specific sections</button>
            <button className={`btn ${scope === "students" ? "btn-primary" : "btn-ghost"}`} onClick={() => setScope("students")}>Specific students</button>
          </div>
          {scope === "specific" && (
            <div className="flex flex-wrap gap-2">
              {sections.length === 0 && <div className="text-sm text-[var(--color-ink2)]">No sections yet. Add classes in Users.</div>}
              {sections.map((s) => {
                const on = sectionIds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => toggleSection(s.id)}
                    className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                      on
                        ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)] font-medium"
                        : "border-[var(--color-line)] text-[var(--color-ink)]"
                    }`}
                  >
                    {s.code}
                  </button>
                );
              })}
            </div>
          )}
          {scope === "students" && <StudentPicker selected={studentIds} setSelected={setStudentIds} />}
        </div>

        {questions.isLoading ? (
          <div className="mt-5"><Loader /></div>
        ) : (
          <QuestionPicker questions={qList} picked={picked} setPicked={setPicked} total={total} />
        )}

        <div className="flex items-center gap-2 mt-5">
          <button className="btn btn-primary" disabled={create.isPending || !title.trim() || picked.length === 0 || !scopeValid} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create assessment"}
          </button>
          <button className="btn btn-ghost" onClick={goBack}>Cancel</button>
        </div>
      </div>
    </div>
  );
}


function QuestionPicker({
  questions, picked, setPicked, total,
}: {
  questions: PickQ[];
  picked: string[];
  setPicked: Dispatch<SetStateAction<string[]>>;
  total: number;
}) {
  const [cat, setCat] = useState("all");
  const [topic, setTopic] = useState("all");
  const [type, setType] = useState("all");
  const [search, setSearch] = useState("");

  const categories = [...new Set(questions.map((q) => q.categoryName).filter(Boolean))].sort() as string[];
  const topics = [...new Set(questions.filter((q) => cat === "all" || q.categoryName === cat).map((q) => q.topic).filter(Boolean))].sort() as string[];
  const types = [...new Set(questions.map((q) => q.type))];

  const shown = questions.filter(
    (q) =>
      (cat === "all" || q.categoryName === cat) &&
      (topic === "all" || q.topic === topic) &&
      (type === "all" || q.type === type) &&
      (!search.trim() || q.prompt.toLowerCase().includes(search.toLowerCase())),
  );

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const allShownPicked = shown.length > 0 && shown.every((q) => picked.includes(q.id));
  const toggleAllShown = () => {
    if (allShownPicked) setPicked((p) => p.filter((id) => !shown.some((q) => q.id === id)));
    else setPicked((p) => [...new Set([...p, ...shown.map((q) => q.id)])]);
  };

  return (
    <div className="mt-5 rounded-xl border border-[var(--color-line)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="font-medium text-[var(--color-ink)]">Pick questions</div>
        <div className="flex items-center gap-2">
          <Pill label={`${picked.length} selected`} color="#1e3a5f" />
          <Pill label={`${total} pts`} color="#5b6470" />
        </div>
      </div>

      <div className="grid sm:grid-cols-4 gap-2 mb-3">
        <select className="input" value={cat} onChange={(e) => { setCat(e.target.value); setTopic("all"); }}>
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input" value={topic} onChange={(e) => setTopic(e.target.value)}>
          <option value="all">All topics</option>
          {topics.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">All types</option>
          {types.map((t) => <option key={t} value={t}>{Q_TYPE_LABEL[t] ?? t}</option>)}
        </select>
        <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search prompt…" />
      </div>

      <div className="flex items-center justify-between mb-2">
        <div className="mono-label">{shown.length} shown · {questions.length} total</div>
        {shown.length > 0 && (
          <button type="button" className="text-sm text-[var(--brand)] hover:underline" onClick={toggleAllShown}>
            {allShownPicked ? "Clear shown" : "Select all shown"}
          </button>
        )}
      </div>

      <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
        {questions.length === 0 && <div className="text-sm text-[var(--color-ink2)]">No questions in bank yet.</div>}
        {questions.length > 0 && shown.length === 0 && <div className="text-sm text-[var(--color-ink2)]">No questions match these filters.</div>}
        {shown.map((q) => {
          const on = picked.includes(q.id);
          return (
            <label
              key={q.id}
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition ${
                on ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)]" : "border-[var(--color-line)]"
              }`}
            >
              <input type="checkbox" checked={on} onChange={() => toggle(q.id)} />
              <span className="text-sm text-[var(--color-ink)] flex-1 truncate">{q.prompt}</span>
              <span className="flex items-center gap-1.5 shrink-0">
                {q.categoryName && <Pill label={q.categoryName} color="#0f766e" />}
                <Pill label={Q_TYPE_LABEL[q.type] ?? q.type} color="#7c3aed" />
                <span className="mono-label">{q.points}p</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
