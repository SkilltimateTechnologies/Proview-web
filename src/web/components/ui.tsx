import { useState, useEffect, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, ChevronLeft, ChevronRight } from "lucide-react";

export const PAGE_SIZE = 20;

/**
 * Client-side pagination for any list. Returns the current page slice plus
 * paging metadata. Resets to page 1 whenever the underlying list identity or
 * length changes (e.g. after filtering).
 */
export function usePagination<T>(items: T[], pageSize: number = PAGE_SIZE) {
  const [page, setPage] = useState(1);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => {
    if (page > pageCount) setPage(1);
  }, [page, pageCount]);
  const pageItems = useMemo(() => items.slice((page - 1) * pageSize, page * pageSize), [items, page, pageSize]);
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return { page, setPage, pageCount, total, pageItems, from, to, pageSize };
}

/** Pager bar: "X–Y of N" + prev/next + numbered pages. Hidden when 1 page. */
export function Pager({ page, pageCount, from, to, total, onChange, unit = "records" }: { page: number; pageCount: number; from: number; to: number; total: number; onChange: (p: number) => void; unit?: string }) {
  if (pageCount <= 1) return null;
  const nums: (number | "…")[] = [];
  const win = 1;
  for (let n = 1; n <= pageCount; n++) {
    if (n === 1 || n === pageCount || (n >= page - win && n <= page + win)) nums.push(n);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
      <div className="mono-label">{from}–{to} of {total} {unit}</div>
      <div className="flex items-center gap-1">
        <button className="pager-btn" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page"><ChevronLeft size={16} /></button>
        {nums.map((n, i) =>
          n === "…" ? (
            <span key={`e${i}`} className="px-1.5 text-[var(--color-muted)]">…</span>
          ) : (
            <button key={n} onClick={() => onChange(n)} className={`pager-num ${n === page ? "on" : ""}`}>{n}</button>
          ),
        )}
        <button className="pager-btn" disabled={page >= pageCount} onClick={() => onChange(page + 1)} aria-label="Next page"><ChevronRight size={16} /></button>
      </div>
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="eyebrow">{children}</div>;
}

/** Right-side slide-over drawer. */
export function Drawer({ eyebrow, title, subtitle, onClose, children, width = "max-w-3xl" }: { eyebrow?: string; title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; width?: string }) {
  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Render into document.body via a portal so the fixed overlay always spans
  // the full viewport — page content is wrapped in `.rise` (an element that
  // keeps a lingering `transform` from its animation), which would otherwise
  // become the containing block for `position: fixed` and trap the drawer.
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onClick={onClose}>
      <div className={`w-full ${width} h-full bg-white flex flex-col shadow-2xl animate-[drawerIn_.18s_ease-out]`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-6 pt-6 pb-4 border-b border-[var(--color-line)] shrink-0">
          <div className="min-w-0">
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            <h2 className="page-title" style={{ fontSize: "1.55rem" }}>{title}</h2>
            {subtitle && <div className="mono-label mt-1">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="ml-3 mt-1"><X size={20} className="text-[var(--color-muted)]" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Pill({ label, color, mono = true }: { label: string; color?: string; mono?: boolean }) {
  return (
    <span className="pill" style={{ fontFamily: mono ? undefined : "var(--font-sans)" }}>
      <span className="pill-dot" style={{ background: color ?? "var(--brand)" }} />
      {label}
    </span>
  );
}

export function StatCard({ value, label, icon, tone }: { value: ReactNode; label: string; icon?: ReactNode; tone?: string }) {
  return (
    <div className="card p-5 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="stat-num text-[2rem]" style={{ color: tone ?? "var(--color-ink)" }}>{value}</div>
        <div className="mono-label mt-1">{label}</div>
      </div>
      {icon && (
        <div
          className="shrink-0 h-9 w-9 rounded-lg flex items-center justify-center"
          style={{ background: tone ? `${tone}15` : "var(--color-brand-soft)", color: tone ?? "var(--brand)" }}
        >
          {icon}
        </div>
      )}
    </div>
  );
}

export function Loader({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-16 text-[var(--color-muted)]">
      <div className="h-5 w-5 rounded-full border-2 border-[var(--color-line)] border-t-[var(--brand)] animate-spin mr-3" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card p-10 text-center">
      <div className="text-[var(--color-ink)] font-semibold">{title}</div>
      {hint && <div className="text-sm text-[var(--color-ink2)] mt-1">{hint}</div>}
    </div>
  );
}

/** Full color picker: large live swatch + native picker + hex text input. */
export function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const valid = /^#([0-9a-fA-F]{6})$/.test(value);
  return (
    <div className="flex items-center gap-3">
      <label className="relative h-14 w-14 rounded-xl border border-[var(--color-line)] cursor-pointer overflow-hidden shrink-0" style={{ background: valid ? value : "#1e3a5f" }} title="Pick a color">
        <input type="color" value={valid ? value : "#1e3a5f"} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
      </label>
      <div>
        <div className="mono-label mb-1.5">Hex value</div>
        <input
          className="input w-36 uppercase"
          style={{ fontFamily: "var(--font-mono)" }}
          value={value}
          maxLength={7}
          onChange={(e) => { let v = e.target.value; if (!v.startsWith("#")) v = "#" + v.replace(/#/g, ""); onChange(v); }}
          placeholder="#1e3a5f"
        />
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mono-label mb-1.5">{label}</div>
      {children}
    </label>
  );
}

/** A single selectable radio-box row. */
export function RadioBox({ checked, onChange, title, hint }: { checked: boolean; onChange: () => void; title: ReactNode; hint?: ReactNode }) {
  return (
    <div className={`radio-box ${checked ? "on" : ""}`} onClick={onChange} role="radio" aria-checked={checked}>
      <span className="rb-ring" />
      <div className="min-w-0">
        <div className="text-sm font-medium text-[var(--color-ink)]">{title}</div>
        {hint && <div className="text-xs text-[var(--color-ink2)] mt-0.5">{hint}</div>}
      </div>
    </div>
  );
}
