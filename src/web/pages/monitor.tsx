import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, CheckCircle2, Loader2, CalendarClock, CircleDashed, UserX, Pause, Play, Plus, Wifi, WifiOff, RotateCcw } from "lucide-react";
import { api } from "../lib/api";
import { PageHeader } from "../components/shell";
import { Loader, EmptyState, Pill, Drawer } from "../components/ui";

type LiveStudent = {
  attemptId: string;
  examId?: string;
  student: string;
  rollNo: string;
  section?: string;
  status: "in_progress" | "finished" | "not_started" | "absent";
  online?: boolean;
  lastSeenAt?: string | number | null;
  startedAt: string | number | null;
  submittedAt?: string | number | null;
  score?: number | null;
  graded?: boolean;
  snapshot: string | null;
  examTitle?: string;
};

type FilterKey = "all" | "in_progress" | "finished" | "not_started" | "absent";
const FILTERS: { k: FilterKey; label: string }[] = [
  { k: "all", label: "All" },
  { k: "in_progress", label: "In progress" },
  { k: "finished", label: "Finished" },
  { k: "not_started", label: "Not started" },
  { k: "absent", label: "Absent" },
];

function fmtTime(t: string | number | null | undefined) {
  if (!t) return "—";
  const d = new Date(t);
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" });
}

function fmtDateTime(t: number | null) {
  if (!t) return "—";
  return new Date(t).toLocaleString("en-IN", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

function initials(name: string) {
  return name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}

/** Admin outage controls for one live exam: global hold/resume + grant extra minutes. */
function ExamControls({ examId, held, extraMin }: { examId: string; held: boolean; extraMin: number }) {
  const qc = useQueryClient();
  const [mins, setMins] = useState(5);
  const refresh = () => qc.invalidateQueries({ queryKey: ["monitor"] });

  const hold = useMutation({
    mutationFn: async () => (held ? api.exams[":id"].unhold.$post({ param: { id: examId } }) : api.exams[":id"].hold.$post({ param: { id: examId } })),
    onSuccess: refresh,
  });
  const addTime = useMutation({
    mutationFn: async () => api.exams[":id"]["extra-time"].$post({ param: { id: examId }, json: { minutes: mins } }),
    onSuccess: refresh,
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {extraMin > 0 && <Pill label={`+${extraMin} MIN GRANTED`} color="#2e7d5b" />}
      {held && <Pill label="PAUSED" color="#b7791f" />}
      <button
        onClick={() => hold.mutate()}
        disabled={hold.isPending}
        className={`inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-1.5 border transition disabled:opacity-50 ${
          held ? "bg-[var(--color-success)] text-white border-[var(--color-success)]" : "bg-[#b7791f] text-white border-[#b7791f]"
        }`}
        title={held ? "Resume the exam for everyone" : "Pause the whole exam (venue outage) — freezes everyone's timer"}
      >
        {held ? <><Play size={13} /> Resume exam</> : <><Pause size={13} /> Hold exam</>}
      </button>
      <div className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-line)] px-1.5 py-0.5">
        <input
          type="number"
          min={1}
          value={mins}
          onChange={(e) => setMins(Math.max(1, Number(e.target.value) || 1))}
          className="w-12 bg-transparent text-sm text-[var(--color-ink)] outline-none text-center"
        />
        <span className="mono-label pr-1">min</span>
        <button
          onClick={() => addTime.mutate()}
          disabled={addTime.isPending}
          className="inline-flex items-center gap-1 text-xs font-semibold rounded-md px-2 py-1 bg-[var(--brand)] text-white disabled:opacity-50"
          title="Add extra minutes to this exam for everyone"
        >
          <Plus size={12} /> Add time
        </button>
      </div>
    </div>
  );
}

export default function Monitor() {
  const [active, setActive] = useState<LiveStudent | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const q = useQuery({
    queryKey: ["monitor"],
    refetchInterval: 5000,
    queryFn: async () => {
      const res = await api.monitor.$get();
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
  });

  const nextScheduled = (q.data as any)?.nextScheduled as { examId: string; title: string; startAt: number | null } | null | undefined;

  function matchFilter(s: LiveStudent) {
    if (filter === "in_progress") return s.status === "in_progress";
    if (filter === "finished") return s.status === "finished";
    if (filter === "not_started") return s.status === "not_started";
    if (filter === "absent") return s.status === "absent";
    return true;
  }

  return (
    <div className="rise">
      <PageHeader eyebrow="Proctoring" title="Live Monitor" action={<Pill label="AUTO-REFRESH 5s" color="#2e7d5b" />} />

      {q.isLoading ? (
        <Loader />
      ) : !q.data?.live.length ? (
        nextScheduled ? (
          <div className="card p-8 text-center rise">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-brand-soft)] mb-4">
              <CalendarClock size={26} className="text-[var(--brand)]" />
            </div>
            <div className="text-lg font-semibold text-[var(--color-ink)] mb-1">No assessment is live right now</div>
            <div className="text-sm text-[var(--color-ink2)]">
              Next scheduled assessment: <span className="font-medium text-[var(--color-ink)]">{nextScheduled.title}</span>
            </div>
            <div className="mono-label mt-1">{fmtDateTime(nextScheduled.startAt)}</div>
          </div>
        ) : (
          <EmptyState title="No exams scheduled" hint="There are no live or upcoming assessments. Live candidates will appear here in real time once an exam goes live." />
        )
      ) : (
        <div className="space-y-6">
          {q.data.live.map((ex) => {
            const students = (ex.students as LiveStudent[]).filter(matchFilter);
            const total = ex.students.length;
            const inProg = (ex.students as LiveStudent[]).filter((s) => s.status === "in_progress").length;
            const done = (ex.students as LiveStudent[]).filter((s) => s.status === "finished").length;
            const notStarted = (ex.students as LiveStudent[]).filter((s) => s.status === "not_started").length;
            const absent = (ex.students as LiveStudent[]).filter((s) => s.status === "absent").length;
            const online = (ex.students as LiveStudent[]).filter((s) => s.status === "in_progress" && s.online).length;
            return (
              <div key={ex.examId} className="card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[var(--color-ink)]">{ex.title}</span>
                      <Pill label="LIVE" color="#c0453b" />
                    </div>
                    <div className="mono-label mt-1">
                      {inProg} in progress · {online} online · {done} finished · {notStarted} not started{absent > 0 ? ` · ${absent} absent` : ""}
                    </div>
                  </div>
                  <ExamControls examId={ex.examId} held={!!(ex as any).held} extraMin={(ex as any).extraMin ?? 0} />
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5 mb-4">
                  <div className="flex flex-wrap gap-1.5">
                    {FILTERS.map((f) => {
                      const count = f.k === "all" ? total : f.k === "in_progress" ? inProg : f.k === "finished" ? done : f.k === "absent" ? absent : notStarted;
                      return (
                        <button
                          key={f.k}
                          onClick={() => setFilter(f.k)}
                          className={`text-xs font-medium rounded-lg px-3 py-1.5 border transition ${
                            filter === f.k
                              ? "bg-[var(--brand)] text-white border-[var(--brand)]"
                              : "border-[var(--color-line)] text-[var(--color-ink2)] hover:border-[var(--brand)]"
                          }`}
                        >
                          {f.label} <span className={filter === f.k ? "opacity-80" : "text-[var(--color-muted)]"}>{count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {students.length === 0 ? (
                  <div className="py-10 text-center text-sm text-[var(--color-muted)]">No candidates match this filter.</div>
                ) : (
                  <div className="table-wrap">
                    <div className="table-scroll">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Student</th>
                            <th>Roll No</th>
                            <th>Section</th>
                            <th>Status</th>
                            <th className="text-right">Score</th>
                            <th className="text-right">Started</th>
                            <th className="text-right">Submitted</th>
                          </tr>
                        </thead>
                        <tbody>
                          {students.map((s) => (
                            <tr
                              key={s.attemptId}
                              className="cursor-pointer"
                              onClick={() => setActive({ ...s, examTitle: ex.title })}
                            >
                              <td>
                                <div className="flex items-center gap-3">
                                  <div className="h-9 w-9 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0" style={{ background: "#1e3a5f", fontFamily: "var(--font-mono)" }}>{initials(s.student)}</div>
                                  <span className="font-medium text-[var(--color-ink)] whitespace-nowrap">{s.student}</span>
                                </div>
                              </td>
                              <td><span className="mono-label whitespace-nowrap">{s.rollNo || "—"}</span></td>
                              <td><span className="mono-label whitespace-nowrap">{s.section || "—"}</span></td>
                              <td>
                                {s.status === "in_progress" ? (
                                  <span className="inline-flex items-center gap-2">
                                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--brand)]"><Loader2 size={14} className="animate-spin" /> In progress</span>
                                    {s.online ? (
                                      <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-success)]"><Wifi size={12} /> Online</span>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 text-xs font-medium text-[#b7791f]"><WifiOff size={12} /> Offline</span>
                                    )}
                                  </span>
                                ) : s.status === "finished" ? (
                                  <span className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-success)]"><CheckCircle2 size={14} /> Finished</span>
                                ) : s.status === "absent" ? (
                                  <span className="inline-flex items-center gap-1.5 text-sm font-medium text-[#c0453b]"><UserX size={14} /> Absent</span>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-muted)]"><CircleDashed size={14} /> Not started</span>
                                )}
                              </td>
                              <td className="text-right">
                                {s.status === "finished" && s.graded && s.score != null ? (
                                  <span className="stat-num text-sm" style={{ color: s.score >= 100 ? "#2e7d5b" : s.score <= 0 ? "#c0453b" : "#b7791f" }}>{s.score}/100</span>
                                ) : s.status === "finished" ? (
                                  <span className="mono-label text-[var(--color-muted)]">Grading…</span>
                                ) : (
                                  <span className="mono-label text-[var(--color-muted)]">—</span>
                                )}
                              </td>
                              <td className="text-right"><span className="mono-label">{fmtTime(s.startedAt)}</span></td>
                              <td className="text-right"><span className="mono-label">{s.status === "finished" ? fmtTime(s.submittedAt) : "—"}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {active && <StudentDrawer s={active} onClose={() => setActive(null)} />}
    </div>
  );
}

const LETTERS = ["A", "B", "C", "D", "E", "F"];

type SheetAnswer = {
  id: string;
  prompt: string;
  type: string;
  topic: string | null;
  options: string[] | null;
  correct: unknown;
  explanation: string | null;
  response: unknown;
  score: number | null;
  maxScore: number | null;
  aiNotes: string | null;
  autoGraded: boolean | null;
};

function StudentDrawer({ s, onClose }: { s: LiveStudent; onClose: () => void }) {
  const q = useQuery({
    enabled: !!s.examId && s.status === "finished",
    queryKey: ["monitor-attempt", s.examId, s.attemptId],
    queryFn: async () => {
      const res = await api.reports[":examId"].attempt[":attemptId"].$get({ param: { examId: s.examId!, attemptId: s.attemptId } });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
  });
  const d = q.data && !("message" in q.data) ? q.data : null;
  const answers = (d?.answers ?? []) as SheetAnswer[];

  return (
    <Drawer
      eyebrow="Live status"
      title={s.student}
      subtitle={`${s.rollNo}${s.section ? ` · ${s.section}` : ""} · ${s.examTitle ?? ""}`}
      onClose={onClose}
      width="max-w-3xl"
    >
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {s.status === "in_progress" ? (
          <Pill label="IN PROGRESS" color="#1e3a5f" />
        ) : s.status === "finished" ? (
          <Pill label="FINISHED" color="#2e7d5b" />
        ) : s.status === "absent" ? (
          <Pill label="ABSENT" color="#c0453b" />
        ) : (
          <Pill label="NOT STARTED" color="#8a8f98" />
        )}
        {s.status === "finished" && s.graded && s.score != null && (
          <Pill label={`SCORE ${s.score}/100`} color={s.score >= 100 ? "#2e7d5b" : s.score <= 0 ? "#c0453b" : "#b7791f"} />
        )}
        {s.status !== "not_started" && s.status !== "absent" && (
          <span className="inline-flex items-center gap-1.5 text-sm text-[var(--color-ink2)]"><Clock size={14} /> Started {fmtTime(s.startedAt)}</span>
        )}
        {s.status === "finished" && (
          <span className="inline-flex items-center gap-1.5 text-sm text-[var(--color-ink2)]"><CheckCircle2 size={14} /> Submitted {fmtTime(s.submittedAt)}</span>
        )}
      </div>

      {s.status === "finished" && s.examId && (
        <ReopenControl examId={s.examId} attemptId={s.attemptId} student={s.student} onDone={onClose} />
      )}

      {s.status === "absent" ? (
        <div className="card p-6 text-center text-sm text-[var(--color-ink2)]">
          This candidate did not appear — the exam window has closed and they never started.
        </div>
      ) : s.status === "not_started" ? (
        <div className="card p-6 text-center text-sm text-[var(--color-ink2)]">
          This candidate has not started the exam yet.
        </div>
      ) : s.status === "in_progress" ? (
        <div className="card p-6 text-center text-sm text-[var(--color-ink2)]">
          This candidate is still writing the exam. The answer sheet will be available once they submit.
        </div>
      ) : q.isLoading ? (
        <Loader />
      ) : answers.length === 0 ? (
        <div className="card p-6 text-center text-sm text-[var(--color-ink2)]">No stored answers for this attempt.</div>
      ) : (
        <>
          <div className="mono-label mb-3">Answer sheet ({answers.length})</div>
          <div className="space-y-3">
            {answers.map((a, i) => <AnswerCard key={a.id} a={a} index={i} />)}
          </div>
        </>
      )}
    </Drawer>
  );
}

/** Reopen an accidentally-submitted attempt back to in-progress, keeping the
 *  student's answers. Optionally grant extra minutes to this student only. */
function ReopenControl({ examId, attemptId, student, onDone }: { examId: string; attemptId: string; student: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [addMinutes, setAddMinutes] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const reopen = useMutation({
    mutationFn: async () => {
      const res = await api.exams[":id"].attempts[":attemptId"].reopen.$post({
        param: { id: examId, attemptId },
        json: { addMinutes },
      });
      const body = await res.json().catch(() => ({}) as any);
      if (!res.ok) throw new Error(("message" in body && body.message) || "Could not reopen the attempt.");
      return body;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monitor"] });
      onDone();
    },
    onError: (e: Error) => setErr(e.message),
  });

  if (!confirming) {
    return (
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-page)] p-4 mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-[var(--color-ink)]">Submitted by accident?</div>
            <div className="text-xs text-[var(--color-ink2)] mt-0.5">Reopen this attempt so {student} can continue. Their answers are kept.</div>
          </div>
          <button
            onClick={() => setConfirming(true)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-1.5 border border-[var(--brand)] text-[var(--brand)] hover:bg-[var(--color-brand-soft)] transition"
          >
            <RotateCcw size={13} /> Reopen exam
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--brand)] bg-[var(--color-brand-soft)] p-4 mb-5">
      <div className="text-sm font-medium text-[var(--color-ink)] mb-1">Reopen {student}'s exam?</div>
      <div className="text-xs text-[var(--color-ink2)] mb-3">
        Status flips back to <b>in progress</b> and the timer resumes from their original start time. Answers are preserved. If the exam window is tight, grant extra minutes below (this student only).
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-card)] px-1.5 py-0.5">
          <input
            type="number"
            min={0}
            value={addMinutes}
            onChange={(e) => setAddMinutes(Math.max(0, Number(e.target.value) || 0))}
            className="w-12 bg-transparent text-sm text-[var(--color-ink)] outline-none text-center"
          />
          <span className="mono-label pr-1">extra min</span>
        </div>
        <button
          onClick={() => reopen.mutate()}
          disabled={reopen.isPending}
          className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-1.5 bg-[var(--brand)] text-white disabled:opacity-50"
        >
          {reopen.isPending ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Confirm reopen
        </button>
        <button
          onClick={() => { setConfirming(false); setErr(null); }}
          disabled={reopen.isPending}
          className="text-xs font-semibold text-[var(--color-ink2)] px-2 py-1.5 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      {err && <div className="text-xs mt-2 font-medium" style={{ color: "#c0453b" }}>{err}</div>}
    </div>
  );
}

function AnswerCard({ a, index }: { a: SheetAnswer; index: number }) {
  const full = a.score != null && a.maxScore != null && a.score >= a.maxScore;
  const zero = a.score != null && a.score <= 0;
  const scoreColor = full ? "#2e7d5b" : zero ? "#c0453b" : "#b7791f";
  const objective = a.options && (a.type === "mcq" || a.type === "multi" || a.type === "truefalse" || a.type === "fillblank");

  return (
    <div className="rounded-xl border border-[var(--color-line)] p-3.5">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--color-ink)]">{index + 1}. {a.prompt}</div>
          <div className="mono-label mt-1">{a.type}{a.topic ? ` · ${a.topic}` : ""}</div>
        </div>
        <span className="stat-num text-sm shrink-0" style={{ color: scoreColor }}>
          {a.score ?? 0}/{a.maxScore ?? "—"}
        </span>
      </div>

      {objective ? (
        <ObjectiveAnswer a={a} />
      ) : (
        <SubjectiveAnswer a={a} />
      )}

      {a.aiNotes && (
        <div className="text-xs text-[var(--color-ink2)] mt-2.5 bg-[var(--color-brand-soft)] rounded-lg px-2.5 py-2">
          <span className="font-semibold">AI feedback: </span>{a.aiNotes}
        </div>
      )}
    </div>
  );
}

function ObjectiveAnswer({ a }: { a: SheetAnswer }) {
  const opts = a.options ?? [];
  const correct = a.correct;
  const resp = a.response;
  const isCorrect = (i: number) => (Array.isArray(correct) ? (correct as number[]).includes(i) : correct === i);
  const isChosen = (i: number) => (Array.isArray(resp) ? (resp as number[]).includes(i) : resp === i);
  const answered = Array.isArray(resp) ? resp.length > 0 : resp != null && resp !== "";

  if (a.type === "truefalse") {
    const rows: [string, boolean][] = [["True", true], ["False", false]];
    return (
      <div className="space-y-1.5">
        {rows.map(([lbl, val]) => {
          const chosen = resp === val;
          const isC = correct === val;
          return <OptRow key={lbl} letter={val ? "T" : "F"} label={lbl} correct={isC} chosen={chosen} />;
        })}
        {!answered && <NotAnswered />}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {opts.map((o, i) => (
        <OptRow key={i} letter={LETTERS[i] ?? String(i + 1)} label={o} correct={isCorrect(i)} chosen={isChosen(i)} />
      ))}
      {!answered && <NotAnswered />}
    </div>
  );
}

function NotAnswered() {
  return (
    <div className="text-[13px] font-semibold mt-1 rounded-lg px-3 py-2" style={{ color: "#c0453b", background: "#fdecea", border: "1px solid #f3c6c1" }}>
      Not answered
    </div>
  );
}

function OptRow({ letter, label, correct, chosen }: { letter: string; label: string; correct: boolean; chosen: boolean }) {
  const bg = correct ? "rgba(46,125,91,0.10)" : chosen ? "rgba(192,69,59,0.08)" : "transparent";
  const border = correct ? "#2e7d5b" : chosen ? "#c0453b" : "var(--color-line)";
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm" style={{ background: bg, border: `1px solid ${border}` }}>
      <span className="mono-label shrink-0 w-5">{letter}</span>
      <span className="flex-1 text-[var(--color-ink)]">{label}</span>
      {chosen && <span className="text-xs font-medium" style={{ color: correct ? "#2e7d5b" : "#c0453b" }}>Chosen</span>}
      {correct && !chosen && <span className="text-xs font-medium" style={{ color: "#2e7d5b" }}>Correct</span>}
    </div>
  );
}

function SubjectiveAnswer({ a }: { a: SheetAnswer }) {
  const text = a.response == null || a.response === "" ? null : typeof a.response === "string" ? a.response : JSON.stringify(a.response, null, 2);
  const isCode = a.type === "coding";
  return (
    <div>
      <div className="mono-label mb-1.5">Student's answer</div>
      {text == null ? (
        <div className="text-sm text-[var(--color-muted)] italic">No answer submitted.</div>
      ) : isCode ? (
        <pre className="text-xs bg-[var(--color-page)] border border-[var(--color-line)] rounded-lg p-3 overflow-x-auto whitespace-pre-wrap" style={{ fontFamily: "var(--font-mono)" }}>{text}</pre>
      ) : (
        <div className="text-sm text-[var(--color-ink)] whitespace-pre-wrap bg-[var(--color-page)] border border-[var(--color-line)] rounded-lg p-3">{text}</div>
      )}
    </div>
  );
}
