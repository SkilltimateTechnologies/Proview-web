import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Upload, X, Search, GraduationCap, UserCog, Mail, Sliders, KeyRound, Layers, Copy, Check, Pencil, Trash2, AlertTriangle, Star, Undo2 } from "lucide-react";
import { api } from "../lib/api";
import { PageHeader } from "../components/shell";
import { Loader, EmptyState, Pill, Field, Drawer, usePagination, Pager } from "../components/ui";

const MODULES = [
  { k: "dashboard", label: "Dashboard" },
  { k: "liveMonitor", label: "Live Monitor" },
  { k: "reports", label: "Reports" },
  { k: "questionBank", label: "Question Bank" },
  { k: "exams", label: "Exams" },
  { k: "users", label: "Users" },
  { k: "branding", label: "Branding" },
  { k: "settings", label: "Settings" },
];

type UserRow = {
  userId: string;
  displayId: string;
  role: string;
  enabled: boolean;
  name: string;
  email: string;
  permissions: Record<string, boolean> | null;
};

type StudentRow = {
  id: string;
  displayId?: string;
  rollNo: string;
  name: string;
  email: string | null;
  enabled: boolean;
  classId: string | null;
  originalClassId?: string | null;
};
type ClassRow = { id: string; code: string };
type EliteRow = { id: string; rollNo: string; name: string; enabled: boolean; originalSection: string };

type Filter = "students" | "tpo" | "elite";

const ROLE_META: Record<string, { label: string; color: string }> = {
  super_admin: { label: "Super Admin", color: "#1e3a5f" },
  college_admin: { label: "College Admin", color: "#7c3aed" },
  tpo: { label: "TPO", color: "#0f766e" },
};

function initials(name: string) {
  return name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}

export default function Users() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<Filter>("students");
  const [search, setSearch] = useState("");
  const [sectionFilter, setSectionFilter] = useState("all");
  const [add, setAdd] = useState(false);
  const [eliteAdd, setEliteAdd] = useState(false);
  const [csv, setCsv] = useState(false);
  const [permFor, setPermFor] = useState<UserRow | null>(null);
  const [resetUser, setResetUser] = useState<{ kind: "staff" | "student"; id: string; name: string } | null>(null);
  const [editStudent, setEditStudent] = useState<StudentRow | null>(null);
  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: "staff" | "student"; id: string; name: string; sub: string } | null>(null);

  const list = useQuery({
    queryKey: ["users"],
    queryFn: async () => (await api.users.$get()).json() as Promise<{ users: UserRow[] }>,
  });
  const studentsQ = useQuery({
    queryKey: ["students"],
    queryFn: async () => (await api.students.$get()).json() as Promise<{ students: StudentRow[] }>,
  });
  const classesQ = useQuery({
    queryKey: ["classes"],
    queryFn: async () => (await api.classes.$get()).json() as Promise<{ classes: ClassRow[] }>,
  });
  const eliteQ = useQuery({
    queryKey: ["elite"],
    queryFn: async () => (await api.cohorts.elite.$get()).json() as Promise<{ eliteClassId: string | null; students: EliteRow[] }>,
  });

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => api.users[":id"].$patch({ param: { id }, json: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
  const toggleStudent = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => api.students[":id"].$patch({ param: { id }, json: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["students"] }),
  });
  const removeUser = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.users[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { message?: string }).message || "Delete failed");
      return res;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); setConfirmDelete(null); },
  });
  const removeStudent = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.students[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { message?: string }).message || "Delete failed");
      return res;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["students"] }); setConfirmDelete(null); },
  });

  const s = search.toLowerCase();
  const allUsers = list.data?.users ?? [];
  const tpos = allUsers.filter((u) => u.role === "tpo");
  const students = studentsQ.data?.students ?? [];
  const classes = classesQ.data?.classes ?? [];
  const classMap = new Map(classes.map((c) => [c.id, c.code]));

  const uMatch = (u: UserRow) => u.name.toLowerCase().includes(s) || u.displayId.toLowerCase().includes(s) || u.email.toLowerCase().includes(s);
  const stMatch = (st: StudentRow) => st.name.toLowerCase().includes(s) || st.rollNo.toLowerCase().includes(s);

  // Filter students by search + section
  const filteredStudents = students
    .filter(stMatch)
    .filter((st) => sectionFilter === "all" || (sectionFilter === "__none__" ? !st.classId : st.classId === sectionFilter))
    .sort((a, b) => {
      const la = classMap.get(a.classId ?? "") ?? "zzz";
      const lb = classMap.get(b.classId ?? "") ?? "zzz";
      return la.localeCompare(lb) || a.rollNo.localeCompare(b.rollNo);
    });

  const staffRows = tpos.filter(uMatch);

  const studentPg = usePagination(filteredStudents);
  const staffPg = usePagination(staffRows);

  const eliteStudents = eliteQ.data?.students ?? [];
  const eliteClassId = eliteQ.data?.eliteClassId ?? null;

  const FILTERS: Array<{ k: Filter; label: string; count: number; icon: React.ElementType }> = [
    { k: "students", label: "Students", count: students.length, icon: GraduationCap },
    { k: "elite", label: "Elite batch", count: eliteStudents.length, icon: Star },
    { k: "tpo", label: "TPOs", count: tpos.length, icon: UserCog },
  ];

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Administration"
        title="Users"
        action={
          <div className="flex flex-wrap gap-2">
            {filter === "students" && <button className="btn btn-ghost" onClick={() => navigate("/sections")}><Layers size={16} /> Sections</button>}
            {filter === "students" && <button className="btn btn-ghost" onClick={() => setCsv(true)}><Upload size={16} /> Bulk upload CSV</button>}
            {filter === "students" && <button className="btn btn-primary" onClick={() => setAdd(true)}><Plus size={16} /> Add student</button>}
            {filter === "elite" && <button className="btn btn-primary" onClick={() => setEliteAdd(true)}><Plus size={16} /> Add to Elite batch</button>}
            {filter === "tpo" && <button className="btn btn-primary" onClick={() => setAdd(true)}><Plus size={16} /> Add TPO</button>}
          </div>
        }
      />

      {add && (filter === "students" ? <AddStudent classes={classes} onClose={() => setAdd(false)} /> : <AddUser role="tpo" onClose={() => setAdd(false)} />)}
      {editStudent && <AddStudent classes={classes} initial={editStudent} onClose={() => setEditStudent(null)} />}
      {editUser && <AddUser role={editUser.role === "college_admin" ? "college_admin" : "tpo"} initial={editUser} onClose={() => setEditUser(null)} />}
      {eliteAdd && <AddToElite students={students} classes={classes} eliteClassId={eliteClassId} onClose={() => setEliteAdd(false)} />}
      {csv && <CsvUpload onClose={() => setCsv(false)} />}
      {permFor && <PermissionDrawer user={permFor} onClose={() => setPermFor(null)} />}
      {resetUser && <ResetPasswordDrawer target={resetUser} onClose={() => setResetUser(null)} />}
      {confirmDelete && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={() => { if (!removeUser.isPending && !removeStudent.isPending) setConfirmDelete(null); }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-4">
              <div className="h-11 w-11 rounded-full flex items-center justify-center shrink-0" style={{ background: "#fdecea", color: "#c0453b" }}><AlertTriangle size={22} /></div>
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-[var(--color-ink)]">Delete {confirmDelete.kind === "student" ? "student" : "user"}?</h3>
                <p className="text-sm text-[var(--color-ink2)] mt-1 leading-relaxed">
                  <span className="font-medium text-[var(--color-ink)]">{confirmDelete.name}</span> <span className="mono-label">({confirmDelete.sub})</span> will be permanently removed
                  {confirmDelete.kind === "student" ? ", along with all their exam attempts, answers and results." : " and will lose all access."} This cannot be undone.
                </p>
              </div>
            </div>
            {(removeUser.error || removeStudent.error) && (
              <div className="mt-4 text-sm text-[#c0453b] bg-[#fdecea] rounded-lg px-3 py-2">
                {(removeUser.error as Error)?.message || (removeStudent.error as Error)?.message}
              </div>
            )}
            <div className="flex gap-2 justify-end mt-6">
              <button className="btn btn-ghost" disabled={removeUser.isPending || removeStudent.isPending} onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button
                className="btn btn-danger"
                disabled={removeUser.isPending || removeStudent.isPending}
                onClick={() => confirmDelete.kind === "student" ? removeStudent.mutate(confirmDelete.id) : removeUser.mutate(confirmDelete.id)}
              >
                <Trash2 size={16} /> {(removeUser.isPending || removeStudent.isPending) ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Segmented filter (pills, not tabs) */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="flex gap-1 p-1 rounded-xl bg-[var(--color-brand-soft)] w-full sm:w-fit overflow-x-auto no-scrollbar">
          {FILTERS.map((f) => {
            const Icon = f.icon;
            const active = filter === f.k;
            return (
              <button
                key={f.k}
                onClick={() => { setFilter(f.k); setAdd(false); setEliteAdd(false); setCsv(false); setEditStudent(null); setEditUser(null); }}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors shrink-0 ${active ? "bg-white shadow-sm text-[var(--color-ink)]" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"}`}
              >
                <Icon size={16} className={active ? "text-[var(--brand)]" : ""} />
                {f.label}
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${active ? "bg-[var(--color-brand-soft)] text-[var(--brand)]" : "bg-white/60"}`} style={{ fontFamily: "var(--font-mono)" }}>{f.count}</span>
              </button>
            );
          })}
        </div>
        <div className="relative flex-1">
          <Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)]" />
          <input className="input pl-10" placeholder={filter === "tpo" ? "Search name, ID or email…" : "Search name or roll no…"} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {filter === "students" && (
          <select className="input sm:w-56" value={sectionFilter} onChange={(e) => setSectionFilter(e.target.value)}>
            <option value="all">All sections</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
            <option value="__none__">No section</option>
          </select>
        )}
      </div>

      {filter === "elite" ? (
        <EliteBatch rows={eliteStudents} classes={classes} loading={eliteQ.isLoading} search={s} onAdd={() => setEliteAdd(true)} />
      ) : filter === "students" ? (
        studentsQ.isLoading ? (
          <Loader />
        ) : filteredStudents.length === 0 ? (
          <EmptyState title="No students yet" hint="Add students or bulk upload a CSV to get started." />
        ) : (
          <>
            <div className="mono-label mb-2">{filteredStudents.length} student{filteredStudents.length === 1 ? "" : "s"}</div>
            <div className="table-wrap">
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Roll No</th>
                      <th className="hidden lg:table-cell">Email</th>
                      <th>Section</th>
                      <th>Status</th>
                      <th className="text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {studentPg.pageItems.map((st) => (
                      <tr key={st.id}>
                        <td>
                          <div className="flex items-center gap-3">
                            <div className="h-9 w-9 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0" style={{ background: "#1e3a5f", fontFamily: "var(--font-mono)" }}>{initials(st.name)}</div>
                            <span className="font-medium text-[var(--color-ink)] whitespace-nowrap">{st.name}</span>
                          </div>
                        </td>
                        <td><span className="mono-label whitespace-nowrap">{st.rollNo}</span></td>
                        <td className="hidden lg:table-cell"><span className="text-[var(--color-ink2)]">{st.email || "—"}</span></td>
                        <td>{st.classId ? <Pill label={classMap.get(st.classId) ?? "Section"} color="#1e3a5f" /> : <span className="text-[var(--color-muted)]">—</span>}</td>
                        <td><Pill label={st.enabled ? "Active" : "Disabled"} color={st.enabled ? "#2e7d5b" : "#c0453b"} /></td>
                        <td className="text-right">
                          <div className="inline-flex items-center gap-2">
                            <button className="btn btn-ghost !py-1.5 !px-2.5" title="Edit" onClick={() => setEditStudent(st)}><Pencil size={15} /></button>
                            <button className="btn btn-ghost !py-1.5 !px-2.5" title="Reset password" onClick={() => setResetUser({ kind: "student", id: st.id, name: st.name })}><KeyRound size={15} /></button>
                            <button className={st.enabled ? "btn btn-danger !py-1.5 !px-3" : "btn btn-ghost !py-1.5 !px-3"} onClick={() => toggleStudent.mutate({ id: st.id, enabled: !st.enabled })}>
                              {st.enabled ? "Disable" : "Enable"}
                            </button>
                            <button className="btn btn-ghost !py-1.5 !px-2.5 !text-[#c0453b]" title="Delete student" onClick={() => setConfirmDelete({ kind: "student", id: st.id, name: st.name, sub: st.rollNo })}><Trash2 size={15} /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <Pager {...studentPg} onChange={studentPg.setPage} unit="students" />
          </>
        )
      ) : list.isLoading ? (
        <Loader />
      ) : (
        (() => {
          const rows = staffRows;
          if (rows.length === 0) return <EmptyState title="No TPOs found" />;
          return (
            <>
              <div className="mono-label mb-2">{rows.length} TPO{rows.length === 1 ? "" : "s"}</div>
              <div className="table-wrap">
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>ID</th>
                        <th>Role</th>
                        <th className="hidden lg:table-cell">Email</th>
                        <th>Status</th>
                        <th className="text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {staffPg.pageItems.map((u) => {
                        const meta = ROLE_META[u.role] ?? { label: u.role, color: "#5b6470" };
                        return (
                          <tr key={u.userId}>
                            <td>
                              <div className="flex items-center gap-3">
                                <div className="h-9 w-9 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0" style={{ background: meta.color, fontFamily: "var(--font-mono)" }}>{initials(u.name)}</div>
                                <span className="font-semibold text-[var(--color-ink)] whitespace-nowrap">{u.name}</span>
                              </div>
                            </td>
                            <td><span className="mono-label">{u.displayId}</span></td>
                            <td><Pill label={meta.label} color={meta.color} /></td>
                            <td className="hidden lg:table-cell">
                              <span className="inline-flex items-center gap-1.5 text-[var(--color-ink2)]"><Mail size={13} className="shrink-0" /> {u.email}</span>
                            </td>
                            <td><Pill label={u.enabled ? "Active" : "Disabled"} color={u.enabled ? "#2e7d5b" : "#c0453b"} /></td>
                            <td className="text-right">
                              <div className="inline-flex items-center gap-2">
                                {u.role !== "super_admin" && <button className="btn btn-ghost !py-1.5 !px-2.5" title="Edit" onClick={() => setEditUser(u)}><Pencil size={15} /></button>}
                                {u.role === "tpo" && <button className="btn btn-ghost !py-1.5 !px-2.5" title="Permissions" onClick={() => setPermFor(u)}><Sliders size={15} /></button>}
                                {u.role !== "super_admin" && <button className="btn btn-ghost !py-1.5 !px-2.5" title="Reset password" onClick={() => setResetUser({ kind: "staff", id: u.userId, name: u.name })}><KeyRound size={15} /></button>}
                                {u.role !== "super_admin" && (
                                  <button className={u.enabled ? "btn btn-danger !py-1.5 !px-3" : "btn btn-ghost !py-1.5 !px-3"} onClick={() => toggle.mutate({ id: u.userId, enabled: !u.enabled })}>
                                    {u.enabled ? "Disable" : "Enable"}
                                  </button>
                                )}
                                {u.role !== "super_admin" && <button className="btn btn-ghost !py-1.5 !px-2.5 !text-[#c0453b]" title="Delete user" onClick={() => setConfirmDelete({ kind: "staff", id: u.userId, name: u.name, sub: u.displayId })}><Trash2 size={15} /></button>}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <Pager {...staffPg} onChange={staffPg.setPage} unit="TPOs" />
            </>
          );
        })()
      )}
    </div>
  );
}

/**
 * ELITE batch panel. Elite is an opt-in-only cohort: students inside it leave
 * their regular section, so regular-section exams (including "All sections")
 * never match them. An exam must explicitly target ELITE for them to see it.
 * Their home section is remembered so they can be restored any time.
 */
function EliteBatch({ rows, classes, loading, search, onAdd }: { rows: EliteRow[]; classes: ClassRow[]; loading: boolean; search: string; onAdd: () => void }) {
  const qc = useQueryClient();
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [moveTo, setMoveTo] = useState("");
  const [msg, setMsg] = useState("");

  const remove = useMutation({
    mutationFn: async ({ studentIds, classId }: { studentIds: string[]; classId?: string }) => {
      const res = await api.cohorts.elite.remove.$post({ json: classId ? { studentIds, classId } : { studentIds } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { message?: string }).message || "Failed");
      return res.json() as Promise<{ restoredCount: number; restored: { rollNo: string; to: string }[]; noOriginal: string[] }>;
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["elite"] });
      qc.invalidateQueries({ queryKey: ["students"] });
      setSel({});
      setMsg(
        `Moved ${d.restoredCount} student${d.restoredCount === 1 ? "" : "s"} out of Elite` +
        (d.noOriginal.length ? ` — ${d.noOriginal.length} had no original section on record (${d.noOriginal.join(", ")}); pick a section below to move them.` : "."),
      );
    },
    onError: (e: Error) => setMsg(e.message),
  });

  const shown = rows.filter((r) => !search || r.name.toLowerCase().includes(search) || r.rollNo.toLowerCase().includes(search));
  const pg = usePagination(shown);
  const selIds = Object.keys(sel).filter((k) => sel[k]);
  const allShownChecked = shown.length > 0 && shown.every((r) => sel[r.id]);

  if (loading) return <Loader />;

  return (
    <>
      <div className="card p-4 mb-4 flex flex-wrap items-start gap-3 justify-between">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: "#fff6dd", color: "#a8790b" }}><Star size={18} /></div>
          <div className="text-sm text-[var(--color-ink2)] leading-relaxed max-w-2xl">
            <span className="font-semibold text-[var(--color-ink)]">Opt-in cohort.</span> Elite students are excluded from every regular exam — even ones assigned to
            “All sections”. They only get exams where <span className="mono-label">ELITE</span> is picked as a section. Past results keep showing their original section.
          </div>
        </div>
        {rows.length === 0 && <button className="btn btn-primary shrink-0" onClick={onAdd}><Plus size={16} /> Add to Elite batch</button>}
      </div>

      {msg && (
        <div className="mb-4 text-sm rounded-lg px-3 py-2 bg-[var(--color-brand-soft)] text-[var(--color-ink)] flex items-start gap-2">
          <Check size={16} className="mt-0.5 shrink-0 text-[var(--brand)]" /> <span>{msg}</span>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState title="No students in the Elite batch yet" hint="Add students by roll number or pick them from a section." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <div className="mono-label">{shown.length} student{shown.length === 1 ? "" : "s"} in Elite</div>
            {selIds.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 ml-auto">
                <span className="mono-label">{selIds.length} selected</span>
                <select className="input !py-1.5 w-auto" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                  <option value="">Restore to original section</option>
                  {classes.filter((c) => c.code.toUpperCase() !== "ELITE").map((c) => <option key={c.id} value={c.id}>Move to {c.code}</option>)}
                </select>
                <button className="btn btn-danger !py-1.5" disabled={remove.isPending} onClick={() => remove.mutate({ studentIds: selIds, classId: moveTo || undefined })}>
                  <Undo2 size={15} /> {remove.isPending ? "Moving…" : "Remove from Elite"}
                </button>
              </div>
            )}
          </div>
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-10">
                      <input
                        type="checkbox"
                        checked={allShownChecked}
                        onChange={(e) => {
                          const next: Record<string, boolean> = { ...sel };
                          for (const r of shown) next[r.id] = e.target.checked;
                          setSel(next);
                        }}
                      />
                    </th>
                    <th>Student</th>
                    <th>Roll No</th>
                    <th>Original section</th>
                    <th>Status</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pg.pageItems.map((r) => (
                    <tr key={r.id}>
                      <td><input type="checkbox" checked={!!sel[r.id]} onChange={(e) => setSel({ ...sel, [r.id]: e.target.checked })} /></td>
                      <td>
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0" style={{ background: "#a8790b", fontFamily: "var(--font-mono)" }}>{initials(r.name)}</div>
                          <span className="font-medium text-[var(--color-ink)] whitespace-nowrap">{r.name}</span>
                        </div>
                      </td>
                      <td><span className="mono-label whitespace-nowrap">{r.rollNo}</span></td>
                      <td>{r.originalSection ? <Pill label={r.originalSection} color="#1e3a5f" /> : <span className="text-[var(--color-muted)]">—</span>}</td>
                      <td><Pill label={r.enabled ? "Active" : "Disabled"} color={r.enabled ? "#2e7d5b" : "#c0453b"} /></td>
                      <td className="text-right">
                        <button className="btn btn-ghost !py-1.5 !px-3" title={r.originalSection ? `Restore to ${r.originalSection}` : "No original section on record"} disabled={remove.isPending || !r.originalSection} onClick={() => remove.mutate({ studentIds: [r.id] })}>
                          <Undo2 size={15} /> Restore{r.originalSection ? ` to ${r.originalSection}` : ""}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <Pager {...pg} onChange={pg.setPage} unit="students" />
        </>
      )}
    </>
  );
}

/** Add students to ELITE — either by pasting roll numbers or picking from a section. */
function AddToElite({ students, classes, eliteClassId, onClose }: { students: StudentRow[]; classes: ClassRow[]; eliteClassId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"pick" | "paste">("pick");
  const [sectionFilter, setSectionFilter] = useState("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [paste, setPaste] = useState("");
  const [result, setResult] = useState<{ movedCount: number; notFound: string[]; alreadyElite: string[] } | null>(null);
  const [err, setErr] = useState("");

  const classMap = new Map(classes.map((c) => [c.id, c.code]));
  const pool = students
    .filter((s) => !eliteClassId || s.classId !== eliteClassId)
    .filter((s) => sectionFilter === "all" || s.classId === sectionFilter)
    .filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()) || s.rollNo.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (classMap.get(a.classId ?? "") ?? "zzz").localeCompare(classMap.get(b.classId ?? "") ?? "zzz") || a.rollNo.localeCompare(b.rollNo));

  const rolls = paste.split(/[\s,;]+/).map((r) => r.trim()).filter(Boolean);
  const selIds = Object.keys(sel).filter((k) => sel[k]);

  const addM = useMutation({
    mutationFn: async () => {
      const json = tab === "paste" ? { rollNos: rolls } : { studentIds: selIds };
      const res = await api.cohorts.elite.add.$post({ json });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { message?: string }).message || "Failed");
      return res.json() as Promise<{ movedCount: number; notFound: string[]; alreadyElite: string[] }>;
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["elite"] });
      qc.invalidateQueries({ queryKey: ["students"] });
      qc.invalidateQueries({ queryKey: ["classes"] });
      setResult(d);
      setSel({});
      setPaste("");
    },
    onError: (e: Error) => setErr(e.message),
  });

  const count = tab === "paste" ? rolls.length : selIds.length;

  return (
    <Drawer eyebrow="Elite batch" title="Add students to Elite" subtitle="They leave their current section and stop receiving regular exams. Their home section is saved so you can restore them later." onClose={onClose}>
      <div className="flex gap-1 p-1 rounded-xl bg-[var(--color-brand-soft)] w-fit mb-4">
        {([["pick", "Pick from sections"], ["paste", "Paste roll numbers"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => { setTab(k); setResult(null); setErr(""); }} className={`px-3.5 py-2 rounded-lg text-sm font-medium ${tab === k ? "bg-white shadow-sm text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>{label}</button>
        ))}
      </div>

      {result && (
        <div className="mb-4 text-sm rounded-lg px-3 py-2 bg-[#e8f5ee] text-[#1d5c3f]">
          Added {result.movedCount} student{result.movedCount === 1 ? "" : "s"} to Elite.
          {result.alreadyElite.length > 0 && ` ${result.alreadyElite.length} were already in Elite.`}
          {result.notFound.length > 0 && ` Not found: ${result.notFound.join(", ")}.`}
        </div>
      )}
      {err && <div className="mb-4 text-sm text-[#c0453b] bg-[#fdecea] rounded-lg px-3 py-2">{err}</div>}

      {tab === "paste" ? (
        <Field label="Roll numbers (one per line, or comma separated)">
          <textarea className="input min-h-[220px]" style={{ fontFamily: "var(--font-mono)" }} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"23K91A0501\n23K91A0502"} />
        </Field>
      ) : (
        <>
          <div className="flex flex-col sm:flex-row gap-3 mb-3">
            <div className="relative flex-1">
              <Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)]" />
              <input className="input pl-10" placeholder="Search name or roll no…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <select className="input sm:w-52" value={sectionFilter} onChange={(e) => setSectionFilter(e.target.value)}>
              <option value="all">All sections</option>
              {classes.filter((c) => c.id !== eliteClassId).map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
            </select>
            <button
              className="btn btn-ghost"
              onClick={() => {
                const next: Record<string, boolean> = { ...sel };
                const on = !pool.every((s) => sel[s.id]);
                for (const s of pool) next[s.id] = on;
                setSel(next);
              }}
            >
              {pool.every((s) => sel[s.id]) && pool.length > 0 ? "Clear" : "Select"} all shown ({pool.length})
            </button>
          </div>
          <div className="border border-[var(--color-line)] rounded-xl max-h-[45vh] overflow-y-auto divide-y divide-[var(--color-line)]">
            {pool.length === 0 ? (
              <div className="p-6 text-center text-sm text-[var(--color-muted)]">No matching students.</div>
            ) : pool.map((s) => (
              <label key={s.id} className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-[var(--color-brand-soft)]">
                <input type="checkbox" checked={!!sel[s.id]} onChange={(e) => setSel({ ...sel, [s.id]: e.target.checked })} />
                <span className="font-medium text-[var(--color-ink)] flex-1 min-w-0 truncate">{s.name}</span>
                <span className="mono-label">{s.rollNo}</span>
                <span className="mono-label w-16 text-right">{classMap.get(s.classId ?? "") ?? "—"}</span>
              </label>
            ))}
          </div>
        </>
      )}

      <div className="flex justify-end gap-2 mt-5">
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
        <button className="btn btn-primary" disabled={count === 0 || addM.isPending} onClick={() => { setErr(""); addM.mutate(); }}>
          <Star size={16} /> {addM.isPending ? "Adding…" : `Add ${count || ""} to Elite`}
        </button>
      </div>
    </Drawer>
  );
}

function AddUser({ role, initial, onClose }: { role: "tpo" | "college_admin"; initial?: UserRow; onClose: () => void }) {
  const qc = useQueryClient();
  const isAdmin = role === "college_admin";
  const editing = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [perms, setPerms] = useState<Record<string, boolean>>(initial?.permissions ?? { dashboard: true, liveMonitor: true, reports: true });
  const [err, setErr] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      if (editing) {
        const res = await api.users[":id"].$patch({ param: { id: initial!.userId }, json: { name, email, phone, permissions: isAdmin ? undefined : perms } });
        if (!res.ok) throw new Error((await res.json() as { message?: string }).message ?? "Failed");
        return res.json();
      }
      const res = await api.users.$post({ json: { name, email, password, phone, role, permissions: isAdmin ? undefined : perms } });
      if (!res.ok) throw new Error((await res.json() as { message?: string }).message ?? "Failed");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <Drawer
      eyebrow={isAdmin ? "College admin" : "TPO user"}
      title={editing ? (isAdmin ? "Edit college admin" : "Edit TPO user") : isAdmin ? "Add college admin" : "Add TPO user"}
      onClose={onClose}
    >
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        {!editing && <Field label="Password"><input className="input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min 8 chars" /></Field>}
        <Field label="Phone"><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
      </div>
      {isAdmin ? (
        <div className="text-xs text-[var(--color-muted)] mt-3">College admins have full access to all modules for their college.</div>
      ) : (
        <div className="mt-4">
          <div className="mono-label mb-2">Module permissions</div>
          <div className="grid sm:grid-cols-2 gap-2">
            {MODULES.map((m) => (
              <label key={m.k} className="flex items-center gap-2.5 rounded-lg border border-[var(--color-line)] px-3 py-2 cursor-pointer">
                <input type="checkbox" checked={!!perms[m.k]} onChange={() => setPerms((p) => ({ ...p, [m.k]: !p[m.k] }))} />
                <span className="text-sm text-[var(--color-ink)]">{m.label}</span>
              </label>
            ))}
          </div>
          <div className="text-xs text-[var(--color-muted)] mt-2">Reports are always finished-assessments-only for TPOs.</div>
        </div>
      )}
      {err && <div className="text-sm text-[var(--color-danger)] mt-3">{err}</div>}
      <button className="btn btn-primary mt-5" disabled={create.isPending || !name || !email || (!editing && password.length < 8)} onClick={() => create.mutate()}>
        {create.isPending ? "Saving…" : editing ? "Save changes" : "Create user"}
      </button>
    </Drawer>
  );
}

function AddStudent({ classes, initial, onClose }: { classes: ClassRow[]; initial?: StudentRow; onClose: () => void }) {
  const qc = useQueryClient();
  const editing = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [rollNo, setRollNo] = useState(initial?.rollNo ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [classId, setClassId] = useState(initial?.classId ?? "");
  const [err, setErr] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      if (editing) {
        const res = await api.students[":id"].$patch({ param: { id: initial!.id }, json: { name, rollNo, email, classId: classId || null } });
        if (!res.ok) throw new Error((await res.json() as { message?: string }).message ?? "Failed");
        return res.json();
      }
      const res = await api.students.$post({ json: { name, rollNo, email, classId: classId || undefined } });
      if (!res.ok) throw new Error((await res.json() as { message?: string }).message ?? "Failed");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["students"] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <Drawer eyebrow="Student" title={editing ? "Edit student" : "Add student"} onClose={onClose}>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Roll No"><input className="input" value={rollNo} onChange={(e) => setRollNo(e.target.value)} placeholder="STU-21CS102" /></Field>
        <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Section">
          <select className="input" value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">Select a Section</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
          </select>
        </Field>
      </div>
      {!editing && <div className="text-xs text-[var(--color-muted)] mt-3">Default password <span style={{ fontFamily: "var(--font-mono)" }}>Welcome@123</span> — student resets on first login.</div>}
      {err && <div className="text-sm text-[var(--color-danger)] mt-3">{err}</div>}
      <button className="btn btn-primary mt-5" disabled={create.isPending || !name || !rollNo} onClick={() => create.mutate()}>
        {create.isPending ? "Saving…" : editing ? "Save changes" : "Add student"}
      </button>
    </Drawer>
  );
}

function PermissionDrawer({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [perms, setPerms] = useState<Record<string, boolean>>(user.permissions ?? {});
  const save = useMutation({
    mutationFn: async () => api.users[":id"].$patch({ param: { id: user.userId }, json: { permissions: perms } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-40 bg-black/30 flex justify-end" onClick={onClose}>
      <div className="w-full max-w-md h-full bg-white p-6 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <div className="eyebrow">Permissions</div>
          <button onClick={onClose}><X size={20} className="text-[var(--color-muted)]" /></button>
        </div>
        <h2 className="page-title mb-1" style={{ fontSize: "1.8rem" }}>{user.name}</h2>
        <div className="mono-label mb-5">{user.displayId} · {user.email}</div>
        <div className="space-y-2">
          {MODULES.map((m) => (
            <label key={m.k} className="flex items-center justify-between rounded-lg border border-[var(--color-line)] px-4 py-3 cursor-pointer">
              <span className="text-sm text-[var(--color-ink)]">{m.label}</span>
              <input type="checkbox" checked={!!perms[m.k]} onChange={() => setPerms((p) => ({ ...p, [m.k]: !p[m.k] }))} />
            </label>
          ))}
        </div>
        <button className="btn btn-primary w-full mt-5" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save permissions"}
        </button>
      </div>
    </div>
  );
}

function CsvUpload({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<{ inserted: number; skipped: number; createdSections: number } | null>(null);

  function parseLine(line: string): string[] {
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  }

  function parse(text: string) {
    const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    if (lines.length < 2) return setErr("CSV needs a header and at least one row.");
    const header = parseLine(lines[0]).map((h) => h.trim().toLowerCase());
    const out = lines.slice(1).map((l) => {
      const cells = parseLine(l);
      const obj: Record<string, string> = {};
      header.forEach((h, i) => (obj[h] = (cells[i] ?? "").trim()));
      return obj;
    });
    setErr("");
    setRows(out);
  }

  // Header keys are lowercased + trimmed. Accept "roll number"/"rollno"/"roll",
  // and pick the first class from a multi-section value like "CSE - A, EEE".
  const pick = (r: Record<string, string>, ...keys: string[]) => {
    for (const k of keys) if (r[k] != null && r[k] !== "") return r[k];
    return "";
  };

  const upload = useMutation({
    mutationFn: async () => {
      const mapped = rows.map((r) => ({
        name: pick(r, "name"),
        rollNo: pick(r, "roll number", "rollno", "roll", "roll no"),
        email: pick(r, "email", "e-mail"),
        classCode: pick(r, "class", "classcode", "class code", "section").split(",")[0].trim(),
      }));
      const res = await api.students.bulk.$post({ json: { rows: mapped } });
      if (!res.ok) throw new Error((await res.json() as { message?: string }).message ?? "Upload failed");
      return res.json() as Promise<{ inserted: number; skipped: number; createdSections: number }>;
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["students"] });
      qc.invalidateQueries({ queryKey: ["classes"] });
      setResult(d);
    },
    onError: (e: Error) => setErr(e.message),
  });

  // Result summary screen — shows how many were added vs already registered.
  if (result) {
    const nothingNew = result.inserted === 0;
    return (
      <div className="card p-5 mb-5">
        <div className="flex items-center justify-between mb-4">
          <div className="font-semibold">Import complete</div>
          <button onClick={onClose}><X size={18} className="text-[var(--color-muted)]" /></button>
        </div>
        <div className={`rounded-xl p-4 mb-4 ${nothingNew ? "bg-[#fef6e7]" : "bg-[#eaf6ef]"}`}>
          <div className="flex items-center gap-2 font-semibold mb-1" style={{ color: nothingNew ? "#b7791f" : "#2e7d5b" }}>
            <Check size={18} />
            {nothingNew
              ? "No new students — everyone in this file is already registered."
              : `${result.inserted} new student${result.inserted === 1 ? "" : "s"} registered.`}
          </div>
          <div className="text-sm text-[var(--color-ink2)]">
            {result.skipped > 0 && <div>{result.skipped} already registered earlier — skipped.</div>}
            {result.createdSections > 0 && <div>{result.createdSections} new section{result.createdSections === 1 ? "" : "s"} created automatically.</div>}
          </div>
        </div>
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    );
  }

  return (
    <div className="card p-5 mb-5">
      <div className="flex items-center justify-between mb-4">
        <div className="font-semibold">Bulk upload students (CSV)</div>
        <button onClick={onClose} disabled={upload.isPending}><X size={18} className="text-[var(--color-muted)]" /></button>
      </div>
      <div className="text-sm text-[var(--color-ink2)] mb-3">
        Columns: <code className="font-mono text-xs bg-[var(--color-brand-soft)] px-1.5 py-0.5 rounded">name, rollNo, email, class</code> (class = code like CSE-A)
      </div>
      <input type="file" accept=".csv" disabled={upload.isPending} onChange={(e) => { const f = e.target.files?.[0]; if (f) { setErr(""); f.text().then(parse); } }} className="text-sm" />
      {err && <div className="text-sm text-[var(--color-danger)] mt-2">{err}</div>}
      {rows.length > 0 && (
        <>
          <div className="mono-label mt-4 mb-2">{rows.length} rows parsed</div>
          <div className="max-h-52 overflow-y-auto space-y-1">
            {rows.slice(0, 20).map((r, i) => (
              <div key={i} className="text-sm text-[var(--color-ink)] flex gap-3">
                <span className="font-medium">{pick(r, "name")}</span>
                <span className="text-[var(--color-muted)] font-mono text-xs">{pick(r, "roll number", "rollno", "roll", "roll no")}</span>
              </div>
            ))}
            {rows.length > 20 && <div className="text-xs text-[var(--color-muted)]">+ {rows.length - 20} more…</div>}
          </div>
          {upload.isPending && (
            <div className="mt-4">
              <div className="flex items-center justify-between text-sm mb-1.5">
                <span className="text-[var(--color-ink2)]">Registering {rows.length} students…</span>
                <span className="mono-label">please wait</span>
              </div>
              <div className="h-2 rounded-full bg-[var(--color-brand-soft)] overflow-hidden">
                <div className="h-full rounded-full progress-indeterminate" style={{ background: "var(--brand)" }} />
              </div>
            </div>
          )}
          <button className="btn btn-primary mt-4" disabled={upload.isPending} onClick={() => upload.mutate()}>
            {upload.isPending ? "Uploading…" : `Import ${rows.length} students`}
          </button>
        </>
      )}
    </div>
  );
}

function ResetPasswordDrawer({ target, onClose }: { target: { kind: "staff" | "student"; id: string; name: string }; onClose: () => void }) {
  const [mode, setMode] = useState<"default" | "custom">("default");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const minLen = target.kind === "student" ? 6 : 8;

  const reset = useMutation({
    mutationFn: async () => {
      const json = { password: mode === "custom" ? password : undefined };
      const res = target.kind === "student"
        ? await api.students[":id"]["reset-password"].$post({ param: { id: target.id }, json })
        : await api.users[":id"]["reset-password"].$post({ param: { id: target.id }, json });
      if (!res.ok) throw new Error((await res.json() as { message?: string }).message ?? "Failed");
      return res.json() as Promise<{ password: string }>;
    },
    onSuccess: (d) => setResult(d.password),
  });

  function copy() {
    if (result) { navigator.clipboard.writeText(result); setCopied(true); setTimeout(() => setCopied(false), 1500); }
  }

  return (
    <Drawer eyebrow="Security" title="Reset password" subtitle={target.name} onClose={onClose}>
      {result ? (
        <div>
          <div className="card p-5 mb-4">
            <div className="mono-label mb-2">New password</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-lg font-mono font-semibold text-[var(--color-ink)] bg-[var(--color-brand-soft)] rounded-lg px-3 py-2.5">{result}</code>
              <button className="btn btn-ghost !px-3" onClick={copy}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
            </div>
          </div>
          <div className="text-sm text-[var(--color-ink2)]">Share this password with {target.name}. They can change it after signing in.</div>
          <button className="btn btn-primary w-full mt-5" onClick={onClose}>Done</button>
        </div>
      ) : (
        <div>
          <div className="inline-flex gap-1 p-1 rounded-xl bg-[var(--color-brand-soft)] mb-4">
            <button onClick={() => setMode("default")} className={`px-3.5 py-2 rounded-lg text-sm font-medium ${mode === "default" ? "bg-white shadow-sm text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>Default (Welcome@123)</button>
            <button onClick={() => setMode("custom")} className={`px-3.5 py-2 rounded-lg text-sm font-medium ${mode === "custom" ? "bg-white shadow-sm text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>Custom</button>
          </div>
          {mode === "custom" ? (
            <Field label={`New password (min ${minLen} chars)`}>
              <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`min ${minLen} characters`} />
            </Field>
          ) : (
            <div className="text-sm text-[var(--color-ink2)] mb-2">Resets to the default password <span className="font-mono font-semibold text-[var(--color-ink)]">Welcome@123</span>.</div>
          )}
          <button
            className="btn btn-primary w-full mt-5"
            disabled={reset.isPending || (mode === "custom" && password.length < minLen)}
            onClick={() => reset.mutate()}
          >
            <KeyRound size={16} /> {reset.isPending ? "Resetting…" : "Reset password"}
          </button>
        </div>
      )}
    </Drawer>
  );
}
