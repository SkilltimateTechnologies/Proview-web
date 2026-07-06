import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Plus, X, Layers, Pencil, Trash2, Users as UsersIcon, ArrowLeft } from "lucide-react";
import { api } from "../lib/api";
import { PageHeader } from "../components/shell";
import { Loader, EmptyState, Field, Pill, usePagination, Pager } from "../components/ui";

const BRANCHES = ["CSE", "IT", "ECE", "EEE", "MECH", "CIVIL", "AIML", "DS"];
const SECTIONS = ["A", "B", "C", "D", "E"];

type ClassRow = { id: string; code: string; branch: string; section: string; batchStartYear: number; year?: number; createdAt?: number | string };

// createdAt comes back as an ISO string (Drizzle timestamp_ms) — coerce to epoch ms for sorting.
const ts = (v?: number | string) => (v == null ? 0 : typeof v === "number" ? v : new Date(v).getTime());
type StudentRow = { id: string; classId: string | null };

export default function Sections() {
  const [, navigate] = useLocation();
  const [edit, setEdit] = useState<ClassRow | null>(null);
  const [add, setAdd] = useState(false);

  const classesQ = useQuery({
    queryKey: ["classes"],
    queryFn: async () => (await api.classes.$get()).json() as Promise<{ classes: ClassRow[] }>,
  });
  const studentsQ = useQuery({
    queryKey: ["students"],
    queryFn: async () => (await api.students.$get()).json() as Promise<{ students: StudentRow[] }>,
  });

  // Newest section on top, oldest below.
  const classes = (classesQ.data?.classes ?? []).slice().sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
  const students = studentsQ.data?.students ?? [];
  const countFor = (id: string) => students.filter((s) => s.classId === id).length;
  const pg = usePagination(classes);

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Administration"
        title="Sections"
        action={
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost" onClick={() => navigate("/users")}><ArrowLeft size={16} /> Students</button>
            <button className="btn btn-primary" onClick={() => { setEdit(null); setAdd(true); }}><Plus size={16} /> New section</button>
          </div>
        }
      />

      {(add || edit) && <SectionForm initial={edit} onClose={() => { setAdd(false); setEdit(null); }} />}

      {classesQ.isLoading ? (
        <Loader />
      ) : classes.length === 0 ? (
        <EmptyState title="No sections yet" hint="Create a section to organise students by branch and batch." />
      ) : (
        <>
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Section</th>
                    <th>Branch</th>
                    <th>Batch</th>
                    <th>Students</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pg.pageItems.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-lg bg-[var(--color-brand-soft)] flex items-center justify-center text-[var(--color-brand)] shrink-0">
                            <Layers size={17} />
                          </div>
                          <span className="font-mono font-semibold text-[var(--color-ink)] whitespace-nowrap">{c.code}</span>
                        </div>
                      </td>
                      <td><Pill label={c.branch} color="#1e3a5f" /></td>
                      <td><span className="text-[var(--color-ink2)] whitespace-nowrap">Batch {c.batchStartYear}{c.year ? ` · Year ${c.year}` : ""}</span></td>
                      <td>
                        <span className="inline-flex items-center gap-1.5 text-[var(--color-ink2)] whitespace-nowrap">
                          <UsersIcon size={15} /> {countFor(c.id)}
                        </span>
                      </td>
                      <td className="text-right">
                        <div className="inline-flex items-center gap-2">
                          <button className="btn btn-ghost !py-1.5 !px-2.5" title="Edit" onClick={() => { setAdd(false); setEdit(c); }}><Pencil size={15} /></button>
                          <DeleteSection cls={c} count={countFor(c.id)} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <Pager {...pg} onChange={pg.setPage} unit="sections" />
        </>
      )}
    </div>
  );
}

function DeleteSection({ cls, count }: { cls: ClassRow; count: number }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const del = useMutation({
    mutationFn: async () => api.classes[":id"].$delete({ param: { id: cls.id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["classes"] });
      qc.invalidateQueries({ queryKey: ["students"] });
      setConfirm(false);
    },
  });

  if (confirm) {
    return (
      <div className="inline-flex items-center gap-1.5">
        <button className="btn btn-danger !py-1.5 !px-3" disabled={del.isPending} onClick={() => del.mutate()}>
          {del.isPending ? "…" : "Confirm"}
        </button>
        <button className="btn btn-ghost !py-1.5 !px-2.5" onClick={() => setConfirm(false)}><X size={14} /></button>
      </div>
    );
  }
  return (
    <button className="btn btn-ghost !py-1.5 !px-2.5 text-[var(--color-danger)]" title={count > 0 ? `${count} students will be unassigned` : "Delete section"} onClick={() => setConfirm(true)}>
      <Trash2 size={15} />
    </button>
  );
}

function SectionForm({ initial, onClose }: { initial: ClassRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const nowYear = new Date().getFullYear();
  const [branch, setBranch] = useState(initial?.branch ?? "CSE");
  const [section, setSection] = useState(initial?.section ?? "A");
  const [batchStartYear, setBatchStartYear] = useState(initial?.batchStartYear ?? nowYear);
  const [err, setErr] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const json = { branch, section, batchStartYear };
      const res = initial
        ? await api.classes[":id"].$patch({ param: { id: initial.id }, json })
        : await api.classes.$post({ json });
      if (!res.ok) throw new Error((await res.json() as { message?: string }).message ?? "Failed");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["classes"] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div className="card p-5 mb-5">
      <div className="flex items-center justify-between mb-4">
        <div className="font-semibold flex items-center gap-2"><Layers size={18} /> {initial ? "Edit section" : "New section"}</div>
        <button onClick={onClose}><X size={18} className="text-[var(--color-muted)]" /></button>
      </div>
      <div className="grid sm:grid-cols-3 gap-4">
        <Field label="Branch">
          <select className="input" value={branch} onChange={(e) => setBranch(e.target.value)}>
            {BRANCHES.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </Field>
        <Field label="Section">
          <select className="input" value={section} onChange={(e) => setSection(e.target.value)}>
            {SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Batch start year">
          <input className="input" type="number" min={nowYear - 5} max={nowYear + 1} value={batchStartYear} onChange={(e) => setBatchStartYear(Number(e.target.value))} />
        </Field>
      </div>
      <div className="mt-3 text-sm text-[var(--color-ink2)]">Section code: <span className="font-mono font-semibold text-[var(--color-ink)]">{branch}-{section}</span></div>
      {err && <div className="text-sm text-[var(--color-danger)] mt-3">{err}</div>}
      <button className="btn btn-primary mt-4" disabled={save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? "Saving…" : initial ? "Save changes" : "Create section"}
      </button>
    </div>
  );
}
