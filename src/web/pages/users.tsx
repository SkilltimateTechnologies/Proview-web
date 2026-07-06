import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Upload, X, Search, Shield, GraduationCap, UserCog, Mail, Sliders, KeyRound, Layers, Copy, Check, Pencil } from "lucide-react";
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
};
type ClassRow = { id: string; code: string };

type Filter = "students" | "tpo" | "admin";

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
  const [csv, setCsv] = useState(false);
  const [permFor, setPermFor] = useState<UserRow | null>(null);
  const [resetUser, setResetUser] = useState<{ kind: "staff" | "student"; id: string; name: string } | null>(null);
  const [editStudent, setEditStudent] = useState<StudentRow | null>(null);
  const [editUser, setEditUser] = useState<UserRow | null>(null);

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

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => api.users[":id"].$patch({ param: { id }, json: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
  const toggleStudent = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => api.students[":id"].$patch({ param: { id }, json: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["students"] }),
  });

  const s = search.toLowerCase();
  const allUsers = list.data?.users ?? [];
  const admins = allUsers.filter((u) => u.role === "super_admin" || u.role === "college_admin");
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

  const staffRows = (filter === "admin" ? admins : tpos).filter(uMatch);

  const studentPg = usePagination(filteredStudents);
  const staffPg = usePagination(staffRows);

  const FILTERS: Array<{ k: Filter; label: string; count: number; icon: React.ElementType }> = [
    { k: "students", label: "Students", count: students.length, icon: GraduationCap },
    { k: "tpo", label: "TPOs", count: tpos.length, icon: UserCog },
    { k: "admin", label: "Admins", count: admins.length, icon: Shield },
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
            {filter === "tpo" && <button className="btn btn-primary" onClick={() => setAdd(true)}><Plus size={16} /> Add TPO</button>}
            {filter === "admin" && <button className="btn btn-primary" onClick={() => setAdd(true)}><Plus size={16} /> Add admin</button>}
          </div>
        }
      />

      {add && (filter === "students" ? <AddStudent classes={classes} onClose={() => setAdd(false)} /> : <AddUser role={filter === "admin" ? "college_admin" : "tpo"} onClose={() => setAdd(false)} />)}
      {editStudent && <AddStudent classes={classes} initial={editStudent} onClose={() => setEditStudent(null)} />}
      {editUser && <AddUser role={editUser.role === "college_admin" ? "college_admin" : "tpo"} initial={editUser} onClose={() => setEditUser(null)} />}
      {csv && <CsvUpload onClose={() => setCsv(false)} />}
      {permFor && <PermissionDrawer user={permFor} onClose={() => setPermFor(null)} />}
      {resetUser && <ResetPasswordDrawer target={resetUser} onClose={() => setResetUser(null)} />}

      {/* Segmented filter (pills, not tabs) */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="flex gap-1 p-1 rounded-xl bg-[var(--color-brand-soft)] w-full sm:w-fit overflow-x-auto no-scrollbar">
          {FILTERS.map((f) => {
            const Icon = f.icon;
            const active = filter === f.k;
            return (
              <button
                key={f.k}
                onClick={() => { setFilter(f.k); setAdd(false); setCsv(false); setEditStudent(null); setEditUser(null); }}
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
          <input className="input pl-10" placeholder={filter === "students" ? "Search name or roll no…" : "Search name, ID or email…"} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {filter === "students" && (
          <select className="input sm:w-56" value={sectionFilter} onChange={(e) => setSectionFilter(e.target.value)}>
            <option value="all">All sections</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
            <option value="__none__">No section</option>
          </select>
        )}
      </div>

      {filter === "students" ? (
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
          if (rows.length === 0) return <EmptyState title={`No ${filter === "admin" ? "admins" : "TPOs"} found`} />;
          return (
            <>
              <div className="mono-label mb-2">{rows.length} {filter === "admin" ? "admin" : "TPO"}{rows.length === 1 ? "" : "s"}</div>
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
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <Pager {...staffPg} onChange={staffPg.setPage} unit={filter === "admin" ? "admins" : "TPOs"} />
            </>
          );
        })()
      )}
    </div>
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
