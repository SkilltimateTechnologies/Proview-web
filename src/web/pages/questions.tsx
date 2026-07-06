import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Sparkles, Trash2, Check, FolderOpen, ArrowLeft, Pencil, Library } from "lucide-react";
import { api } from "../lib/api";
import { PageHeader } from "../components/shell";
import { Loader, EmptyState, Pill, Field, Drawer, RadioBox, usePagination, Pager } from "../components/ui";

const TYPES = [
  { v: "mcq", label: "MCQ (single)" },
  { v: "multi", label: "Multi-select" },
  { v: "truefalse", label: "True / False" },
  { v: "fillblank", label: "Fill in the blank" },
  { v: "short", label: "Short answer" },
  { v: "essay", label: "Essay" },
  { v: "coding", label: "Coding" },
];
const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPES.map((t) => [t.v, t.label]));

type Gen = { type: string; prompt: string; options?: string[]; correct?: unknown; points?: number; difficulty?: string; meta?: Record<string, unknown> };
type Cat = { id: string; name: string; description?: string | null; questionCount: number };

export default function Questions() {
  const qc = useQueryClient();
  const [active, setActive] = useState<Cat | null>(null);
  const [catDrawer, setCatDrawer] = useState<{ mode: "new" | "edit"; cat?: Cat } | null>(null);

  const cats = useQuery({
    queryKey: ["categories"],
    queryFn: async () => {
      const res = await api.categories.$get();
      if (!res.ok) throw new Error("failed");
      return res.json() as Promise<{ categories: Cat[] }>;
    },
  });

  const delCat = useMutation({
    mutationFn: async (id: string) => api.categories[":id"].$delete({ param: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      setActive(null);
    },
  });

  // keep active category fresh (question counts)
  const activeFresh = active ? cats.data?.categories.find((c) => c.id === active.id) ?? active : null;

  if (activeFresh) {
    return (
      <CategoryView
        cat={activeFresh}
        onBack={() => setActive(null)}
        onDelete={() => {
          if (confirm(`Delete category "${activeFresh.name}"? Its questions will be kept but uncategorized.`)) delCat.mutate(activeFresh.id);
        }}
      />
    );
  }

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Content"
        title="Question Bank"
        action={
          <button className="btn btn-primary" onClick={() => setCatDrawer({ mode: "new" })}>
            <Plus size={16} /> New category
          </button>
        }
      />

      {catDrawer && (
        <CategoryForm
          initial={catDrawer.cat}
          onClose={() => setCatDrawer(null)}
        />
      )}

      {cats.isLoading ? (
        <Loader />
      ) : !cats.data?.categories.length ? (
        <EmptyState title="No categories yet" hint="Create a category (e.g. DSA, Aptitude, OS) to organize your questions." />
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {cats.data.categories.map((c) => (
            <div key={c.id} className="card p-5 hover:shadow-md transition-shadow cursor-pointer group" onClick={() => setActive(c)}>
              <div className="flex items-start justify-between">
                <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: "var(--color-brand-soft)" }}>
                  <FolderOpen size={20} className="text-[var(--brand)]" />
                </div>
                <button
                  className="text-[var(--color-muted)] hover:text-[var(--brand)] opacity-0 group-hover:opacity-100 transition"
                  onClick={(e) => { e.stopPropagation(); setCatDrawer({ mode: "edit", cat: c }); }}
                >
                  <Pencil size={15} />
                </button>
              </div>
              <div className="mt-3 font-semibold text-[var(--color-ink)]">{c.name}</div>
              {c.description && <div className="text-sm text-[var(--color-ink2)] mt-0.5 line-clamp-2">{c.description}</div>}
              <div className="mt-3 flex items-center gap-1.5 text-sm text-[var(--color-muted)]">
                <Library size={14} /> {c.questionCount} question{c.questionCount === 1 ? "" : "s"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryForm({ initial, onClose }: { initial?: Cat; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");

  const save = useMutation({
    mutationFn: async () => {
      if (initial) return api.categories[":id"].$patch({ param: { id: initial.id }, json: { name, description } });
      return api.categories.$post({ json: { name, description } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      onClose();
    },
  });

  return (
    <Drawer eyebrow="Category" title={initial ? "Edit category" : "New category"} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Data Structures" /></Field>
        <Field label="Description (optional)"><input className="input" value={description ?? ""} onChange={(e) => setDescription(e.target.value)} placeholder="Arrays, trees, graphs…" /></Field>
      </div>
      <button className="btn btn-primary mt-5" disabled={save.isPending || !name.trim()} onClick={() => save.mutate()}>
        {save.isPending ? "Saving…" : initial ? "Save changes" : "Create category"}
      </button>
    </Drawer>
  );
}

type Q = {
  id: string; type: string; prompt: string; options?: string[] | null; correct?: unknown;
  points: number; difficulty: string; topic?: string | null; aiGenerated?: boolean;
  isGlobal?: boolean; categoryName?: string | null; ownedByOther?: boolean; ownerName?: string | null;
  meta?: Record<string, unknown> | null;
};

function CategoryView({ cat, onBack, onDelete }: { cat: Cat; onBack: () => void; onDelete: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"none" | "manual" | "ai">("none");
  const [editing, setEditing] = useState<Q | null>(null);
  const [topicFilter, setTopicFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");

  const list = useQuery({
    queryKey: ["questions", cat.id],
    queryFn: async () => {
      const res = await api.questions.$get({ query: { categoryId: cat.id } });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
  });

  const allQuestions = list.data?.questions ?? [];
  const topics = [...new Set(allQuestions.map((q) => q.topic).filter(Boolean))].sort() as string[];
  const shown = allQuestions.filter(
    (q) => (topicFilter === "all" || q.topic === topicFilter) && (typeFilter === "all" || q.type === typeFilter)
  );
  const pg = usePagination(shown);

  const del = useMutation({
    mutationFn: async (id: string) => api.questions[":id"].$delete({ param: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["questions", cat.id] });
      qc.invalidateQueries({ queryKey: ["categories"] });
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["questions", cat.id] });
    qc.invalidateQueries({ queryKey: ["categories"] });
  };

  return (
    <div className="rise">
      <button className="btn btn-ghost mb-3" onClick={onBack}><ArrowLeft size={16} /> All categories</button>
      <PageHeader
        eyebrow="Category"
        title={cat.name}
        action={
          <div className="flex gap-2">
            <button className="btn btn-ghost text-[var(--color-danger)]" onClick={onDelete}><Trash2 size={16} /> Delete</button>
            <button className="btn btn-ghost" onClick={() => setMode("ai")}><Sparkles size={16} /> AI generate</button>
            <button className="btn btn-primary" onClick={() => setMode("manual")}><Plus size={16} /> Add question</button>
          </div>
        }
      />

      {mode === "manual" && <ManualForm categoryId={cat.id} onClose={() => { setMode("none"); refresh(); }} />}
      {mode === "ai" && <AIGenForm categoryId={cat.id} onClose={() => { setMode("none"); refresh(); }} />}
      {editing && <ManualForm categoryId={cat.id} initial={editing} onClose={() => { setEditing(null); refresh(); }} />}

      {allQuestions.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <select className="input sm:w-52" value={topicFilter} onChange={(e) => setTopicFilter(e.target.value)}>
            <option value="all">All topics</option>
            {topics.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className="input sm:w-52" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">All types</option>
            {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
          </select>
          <div className="mono-label flex items-center">{shown.length} of {allQuestions.length} shown</div>
        </div>
      )}

      {list.isLoading ? (
        <Loader />
      ) : !allQuestions.length ? (
        <EmptyState title="No questions in this category" hint="Add questions manually or generate them with AI." />
      ) : !shown.length ? (
        <EmptyState title="No questions match these filters" hint="Try clearing the topic or type filter." />
      ) : (
        <div className="space-y-3">
          {pg.pageItems.map((qn) => (
            <div key={qn.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <Pill label={TYPE_LABEL[qn.type] ?? qn.type} color="#1e3a5f" />
                    <Pill label={`${qn.points} pts`} color="#5b6470" />
                    <Pill label={qn.difficulty} color="#b7791f" />
                    {qn.topic && <span className="text-xs text-[var(--color-muted)]" style={{ fontFamily: "var(--font-mono)" }}>{qn.topic}</span>}
                    {qn.isGlobal ? <Pill label="Global" color="#0f766e" /> : <Pill label="College-only" color="#5b6470" />}
                    {qn.ownedByOther ? <Pill label={qn.ownerName ? `Shared · ${qn.ownerName}` : "Shared"} color="#7c3aed" /> : null}
                    {qn.aiGenerated ? <Sparkles size={14} className="text-[var(--brand)]" /> : null}
                  </div>
                  <div className="text-[var(--color-ink)]">{qn.prompt}</div>
                  {Array.isArray(qn.options) && qn.options.length > 0 && (
                    <div className="mt-2 grid sm:grid-cols-2 gap-1.5">
                      {qn.options.map((o, i) => {
                        const correct =
                          qn.type === "multi"
                            ? Array.isArray(qn.correct) && (qn.correct as number[]).includes(i)
                            : Number(qn.correct) === i;
                        return (
                          <div key={i} className="flex items-center gap-2 text-sm" style={{ color: correct ? "#2e7d5b" : "var(--color-ink2)" }}>
                            <span
                              className="inline-flex items-center justify-center shrink-0 rounded-md font-mono text-xs font-semibold"
                              style={{
                                width: 20, height: 20,
                                background: correct ? "#2e7d5b" : "var(--color-line)",
                                color: correct ? "#fff" : "var(--color-muted)",
                              }}
                            >
                              {String.fromCharCode(65 + i)}
                            </span>
                            <span className="truncate">{o}</span>
                            {correct && <Check size={14} className="shrink-0" />}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                {!qn.ownedByOther && (
                  <div className="flex items-center gap-1.5">
                    <button className="text-[var(--color-muted)] hover:text-[var(--brand)]" onClick={() => setEditing(qn as Q)}>
                      <Pencil size={16} />
                    </button>
                    <button className="text-[var(--color-muted)] hover:text-[var(--color-danger)]" onClick={() => del.mutate(qn.id)}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
          <Pager {...pg} onChange={pg.setPage} unit="questions" />
        </div>
      )}
    </div>
  );
}

function ManualForm({ categoryId, initial, onClose }: { categoryId: string; initial?: Q; onClose: () => void }) {
  const qc = useQueryClient();
  const initCorrect = (): number[] => {
    if (!initial) return [];
    if (initial.type === "multi" && Array.isArray(initial.correct)) return initial.correct as number[];
    if ((initial.type === "mcq" || initial.type === "fillblank") && typeof initial.correct === "number") return [initial.correct as number];
    return [];
  };
  const [type, setType] = useState(initial?.type ?? "mcq");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [options, setOptions] = useState<string[]>(initial?.options?.length ? [...initial.options] : ["", "", "", ""]);
  const [correct, setCorrect] = useState<number[]>(initCorrect());
  const [tfCorrect, setTfCorrect] = useState(initial?.type === "truefalse" ? Boolean(initial.correct) : true);
  const [points, setPoints] = useState(initial?.points ?? 2);
  const [topic, setTopic] = useState(initial?.topic ?? "");
  const [difficulty, setDifficulty] = useState(initial?.difficulty ?? "medium");
  const [isGlobal, setIsGlobal] = useState(initial ? initial.isGlobal !== false : true);
  const [explanation, setExplanation] = useState<string>((initial?.meta as any)?.explanation ?? "");

  const hasOptions = ["mcq", "multi", "fillblank"].includes(type);

  const save = useMutation({
    mutationFn: async () => {
      let correctVal: unknown = null;
      if (type === "mcq" || type === "fillblank") correctVal = correct[0] ?? 0;
      else if (type === "multi") correctVal = correct;
      else if (type === "truefalse") correctVal = tfCorrect;
      const json = {
        categoryId,
        type,
        prompt,
        options: hasOptions ? options.filter((o) => o.trim()) : undefined,
        correct: correctVal,
        points,
        topic,
        difficulty,
        isGlobal,
        meta: { ...(initial?.meta ?? {}), explanation: explanation.trim() || undefined },
      };
      if (initial) return (await api.questions[":id"].$patch({ param: { id: initial.id }, json })).json();
      return (await api.questions.$post({ json })).json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["questions", categoryId] }); onClose(); },
  });

  return (
    <Drawer eyebrow="Question" title={initial ? "Edit question" : "Add question"} onClose={onClose} width="max-w-3xl">
      <div className="grid sm:grid-cols-3 gap-4">
        <Field label="Type">
          <select className="input" value={type} onChange={(e) => { setType(e.target.value); setCorrect([]); }}>
            {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Topic">
          <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="DSA" />
        </Field>
        <Field label="Difficulty">
          <select className="input" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Prompt">
          <textarea className="input" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Enter the question…" />
        </Field>
      </div>

      {hasOptions && (
        <div className="mt-4 space-y-2">
          <div className="mono-label">Options {type === "multi" ? "(check all correct)" : "(pick correct)"}</div>
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type={type === "multi" ? "checkbox" : "radio"}
                checked={correct.includes(i)}
                onChange={() => {
                  if (type === "multi") setCorrect((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]));
                  else setCorrect([i]);
                }}
              />
              <span
                className="inline-flex items-center justify-center shrink-0 rounded-md font-mono text-xs font-semibold"
                style={{
                  width: 24, height: 24,
                  background: correct.includes(i) ? "#2e7d5b" : "var(--color-line)",
                  color: correct.includes(i) ? "#fff" : "var(--color-muted)",
                }}
              >
                {String.fromCharCode(65 + i)}
              </span>
              <input className="input" value={o} onChange={(e) => setOptions((p) => p.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Option ${String.fromCharCode(65 + i)}`} />
            </div>
          ))}
        </div>
      )}

      {type === "truefalse" && (
        <div className="mt-4">
          <div className="mono-label mb-1.5">Correct answer</div>
          <div className="flex gap-2">
            <button className={`btn ${tfCorrect ? "btn-primary" : "btn-ghost"}`} onClick={() => setTfCorrect(true)}>True</button>
            <button className={`btn ${!tfCorrect ? "btn-primary" : "btn-ghost"}`} onClick={() => setTfCorrect(false)}>False</button>
          </div>
        </div>
      )}

      {["short", "essay", "coding"].includes(type) && (
        <div className="mt-4 text-sm text-[var(--color-ink2)] bg-[var(--color-brand-soft)] rounded-lg px-3 py-2">
          This type is graded by AI at submission time. No fixed answer needed.
        </div>
      )}

      <div className="mt-4">
        <Field label="Answer explanation (shown to students in review)">
          <textarea className="input" rows={2} value={explanation} onChange={(e) => setExplanation(e.target.value)} placeholder="Explain why the correct answer is right (optional)…" />
        </Field>
      </div>

      <div className="mt-4">
        <div className="mono-label mb-1.5">Visibility</div>
        <div className="grid sm:grid-cols-2 gap-2">
          <RadioBox
            checked={isGlobal}
            onChange={() => setIsGlobal(true)}
            title="Global (all colleges)"
            hint="Shared and reusable by every college."
          />
          <RadioBox
            checked={!isGlobal}
            onChange={() => setIsGlobal(false)}
            title="College-only"
            hint="Only visible within your college."
          />
        </div>
      </div>
      <div className="mt-4 flex items-end gap-3">
        <Field label="Points">
          <input className="input w-24" type="number" value={points} onChange={(e) => setPoints(Number(e.target.value))} />
        </Field>
        <button className="btn btn-primary" disabled={save.isPending || !prompt.trim()} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : initial ? "Save changes" : "Save question"}
        </button>
      </div>
    </Drawer>
  );
}

function AIGenForm({ categoryId, onClose }: { categoryId: string; onClose: () => void }) {
  const [topic, setTopic] = useState("");
  const [type, setType] = useState("mcq");
  const [count, setCount] = useState(5);
  const [difficulty, setDifficulty] = useState("medium");
  const [preview, setPreview] = useState<Gen[]>([]);

  const gen = useMutation({
    mutationFn: async () => {
      const res = await api.questions.generate.$post({ json: { topic, type, count, difficulty } });
      return res.json();
    },
    onSuccess: (d) => setPreview((d as { questions: Gen[] }).questions ?? []),
  });

  const saveAll = useMutation({
    mutationFn: async () => {
      const res = await api.questions.bulk.$post({ json: { questions: preview.map((p) => ({ ...p, categoryId, topic, difficulty })) } });
      return res.json();
    },
    onSuccess: onClose,
  });

  return (
    <Drawer eyebrow="AI" title="Generate questions" onClose={onClose} width="max-w-3xl">
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Topic"><input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Operating Systems" /></Field>
        <Field label="Type">
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Count"><input className="input" type="number" min={1} max={15} value={count} onChange={(e) => setCount(Number(e.target.value))} /></Field>
        <Field label="Difficulty">
          <select className="input" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </Field>
      </div>
      <button className="btn btn-primary mt-4" disabled={gen.isPending || !topic.trim()} onClick={() => gen.mutate()}>
        {gen.isPending ? "Generating…" : "Generate preview"}
      </button>

      {preview.length > 0 && (
        <div className="mt-5">
          <div className="mono-label mb-2">Preview · {preview.length} questions</div>
          <div className="space-y-2 max-h-[360px] overflow-y-auto">
            {preview.map((p, i) => (
              <div key={i} className="rounded-lg border border-[var(--color-line)] p-3">
                <div className="text-sm font-medium text-[var(--color-ink)]">{p.prompt}</div>
                {Array.isArray(p.options) && (
                  <div className="mt-1 text-xs text-[var(--color-ink2)]">{p.options.join(" · ")}</div>
                )}
              </div>
            ))}
          </div>
          <button className="btn btn-primary mt-4" disabled={saveAll.isPending} onClick={() => saveAll.mutate()}>
            {saveAll.isPending ? "Saving…" : `Save all ${preview.length} to category`}
          </button>
        </div>
      )}
    </Drawer>
  );
}
