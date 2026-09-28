import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Check, KeyRound, ShieldCheck, X } from "lucide-react";
import { previewStudentPasswords, resetStudentPasswords } from "../queries/bulk-student-passwords";
import type { ResetScope } from "../../api/lib/bulk-student-passwords";

export function BulkPasswordReset({ tenantId, selectedIds, totalCount, onClose, onComplete }: {
  tenantId: string; selectedIds: string[]; totalCount: number; onClose: () => void; onComplete: () => void;
}) {
  const [scope, setScope] = useState<"all" | "selected">(selectedIds.length ? "selected" : "all");
  const [mustChangePassword, setMustChangePassword] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [target, setTarget] = useState<ResetScope | null>(null);
  const preview = useMutation(previewStudentPasswords());
  const reset = useMutation({ ...resetStudentPasswords(), onSuccess: () => onComplete() });
  const panel = useRef<HTMLDialogElement>(null);
  const busy = preview.isPending || reset.isPending;
  const busyRef = useRef(busy); busyRef.current = busy;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const count = scope === "all" ? totalCount : selectedIds.length;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    function keydown(e: KeyboardEvent) {
      if (e.key === "Escape" && !busyRef.current) closeRef.current();
      if (e.key !== "Tab") return;
      const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0]; const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);

  function review() {
    const input: ResetScope = scope === "all" ? { tenantId, scope, mustChangePassword } : { tenantId, scope, studentIds: selectedIds, mustChangePassword };
    setTarget(input); setAcknowledged(false); reset.reset();
    preview.mutate(input);
  }
  function back() { preview.reset(); reset.reset(); setAcknowledged(false); setTarget(null); }

  return createPortal(
    <div className="fixed inset-0 z-[80] bg-black/45 flex items-center justify-center p-4">
      <button type="button" tabIndex={-1} aria-label="Dismiss bulk reset" className="absolute inset-0 cursor-default" disabled={busy} onClick={onClose} />
      <dialog open ref={panel} tabIndex={-1} aria-modal="true" aria-labelledby="bulk-reset-title" className="relative m-0 border-0 p-0 text-inherit bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto outline-none">
        <div className="flex gap-3 items-start px-6 pt-6 pb-5 border-b border-[var(--color-line)]">
          <div className="h-10 w-10 rounded-xl bg-[var(--color-brand-soft)] text-[var(--brand)] grid place-items-center shrink-0"><KeyRound size={20} /></div>
          <div className="flex-1"><div className="eyebrow">Student security</div><h2 id="bulk-reset-title" className="font-semibold text-lg text-[var(--color-ink)]">Bulk reset passwords</h2></div>
          <button className="btn btn-ghost !p-2" aria-label="Close bulk reset" disabled={busy} onClick={onClose}><X size={18} /></button>
        </div>
        <div className="p-6 space-y-5">
          {reset.isSuccess ? (
            <output className="block space-y-4">
              <div className="h-12 w-12 rounded-full bg-[#eaf4ee] text-[#246347] grid place-items-center"><Check size={25} /></div>
              <h3 className="font-semibold text-xl text-[var(--color-ink)]">{reset.data.count} student passwords reset</h3>
              <p className="text-sm text-[var(--color-ink2)]">The reset password is <strong className="font-mono text-[var(--color-ink)]">Welcome@123</strong>. {reset.data.mustChangePassword ? "These students must choose a new password at their next login." : "These students do not need to change their password at their next login."}</p>
              <p className="text-sm text-[var(--color-ink2)]">Staff passwords, account status and exam records were not changed.</p>
              <button className="btn btn-primary w-full justify-center" onClick={onClose}>Done</button>
            </output>
          ) : (
            <>
              {!preview.isSuccess ? (
                <>
                  <p className="text-sm text-[var(--color-ink2)]">Choose whose password to reset in the current college. TPO and admin accounts are not included.</p>
                  <fieldset disabled={busy} className="space-y-3">
                    <legend className="sr-only">Reset scope</legend>
                    <label htmlFor="bulk-reset-selected" aria-label="Selected students" className={`flex gap-3 items-start p-4 border rounded-xl cursor-pointer ${scope === "selected" ? "border-[#1e3a5f] bg-[#f5f8fc]" : "border-[var(--color-line)]"} ${!selectedIds.length ? "opacity-50 cursor-not-allowed" : ""}`}>
                      <input className="mt-1 accent-[#1e3a5f]" id="bulk-reset-selected" aria-label="Selected students" type="radio" name="reset-scope" value="selected" disabled={!selectedIds.length} checked={scope === "selected"} onChange={() => { setScope("selected"); preview.reset(); }} />
                      <span><span className="block font-semibold text-sm">Selected students <span className="font-mono">({selectedIds.length})</span></span><span className="block text-xs text-[var(--color-ink2)] mt-1">Only the students checked on the Users page.</span></span>
                    </label>
                    <label htmlFor="bulk-reset-all" aria-label="All students in this college" className={`flex gap-3 items-start p-4 border rounded-xl cursor-pointer ${scope === "all" ? "border-[#1e3a5f] bg-[#f5f8fc]" : "border-[var(--color-line)]"}`}>
                      <input className="mt-1 accent-[#1e3a5f]" id="bulk-reset-all" aria-label="All students in this college" type="radio" name="reset-scope" value="all" checked={scope === "all"} onChange={() => { setScope("all"); preview.reset(); }} />
                      <span><span className="block font-semibold text-sm">All students in this college <span className="font-mono">({totalCount})</span></span><span className="block text-xs text-[var(--color-ink2)] mt-1">Includes all sections, Elite and disabled accounts, regardless of search or filters.</span></span>
                    </label>
                  </fieldset>
                </>
              ) : (
                <>
                  <div className="rounded-xl bg-[var(--color-brand-soft)] p-4">
                    <div className="eyebrow mb-1">Affected college</div><div className="font-semibold text-sm">{preview.data.collegeName}</div>
                    <div className="flex items-baseline gap-2 mt-3"><span className="text-3xl font-semibold text-[var(--brand)]">{preview.data.count}</span><span className="text-sm text-[var(--color-ink2)]">{scope === "all" ? "students · entire college" : "selected students"}</span></div>
                    <p className="text-xs text-[var(--color-ink2)] mt-1">{preview.data.disabledCount} disabled accounts included; their status will remain disabled.</p>
                  </div>
                  <div className="flex gap-3 rounded-xl bg-[#fff7ed] text-[#7c3e12] p-4"><AlertTriangle size={20} className="shrink-0" /><p className="text-sm leading-relaxed">Their current passwords will stop working. This cannot restore their old passwords. Share the temporary password securely.</p></div>
                </>
              )}
              <div className="rounded-xl border border-[var(--color-line)] p-4">
                <div className="mono-label mb-2">Reset password</div><div className="font-mono font-semibold text-lg text-[var(--color-ink)]">Welcome@123</div>
                {!preview.isSuccess && <label htmlFor="bulk-reset-require-change" className="flex gap-3 items-start text-sm text-[var(--color-ink)] cursor-pointer mt-4">
                  <input id="bulk-reset-require-change" aria-label="Require password change at next login" type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[#1e3a5f]" checked={mustChangePassword} disabled={busy} onChange={e => { setMustChangePassword(e.target.checked); preview.reset(); }} />
                  <span>Require password change at next login</span>
                </label>}
                <p className="flex gap-2 text-xs text-[var(--color-ink2)] mt-3"><ShieldCheck size={15} className="shrink-0 text-[#246347]" />{(preview.data?.mustChangePassword ?? mustChangePassword) ? "Students must change it at their next login." : "Students do not need to change it at their next login."} Existing exam records are preserved.</p>
                {!(preview.data?.mustChangePassword ?? mustChangePassword) && <p className="text-xs leading-relaxed rounded-lg bg-[#fff7ed] text-[#7c3e12] p-3 mt-3">Students can keep using Welcome@123. This leaves them with a shared password; requiring a personal password is safer.</p>}
              </div>
              {preview.isSuccess && <label className="flex gap-3 items-start text-sm text-[var(--color-ink2)] cursor-pointer"><input className="mt-1 h-4 w-4 shrink-0 accent-[#1e3a5f]" aria-label="I confirm resetting these student passwords to the default temporary password" type="checkbox" checked={acknowledged} disabled={busy} onChange={e => setAcknowledged(e.target.checked)} /><span>I confirm resetting these {preview.data.count} student passwords to Welcome@123, {preview.data.mustChangePassword ? "with a required password change at next login." : "without requiring a password change at next login."}</span></label>}
              {(preview.error || reset.error) && <p role="alert" className="text-sm rounded-lg bg-[#fdeeed] text-[#a32c25] p-3">{(reset.error ?? preview.error)?.message} {reset.error && "If the connection was interrupted, the reset may already have completed. Check before using Back to review and try again."}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <button className="btn btn-ghost" disabled={busy} onClick={preview.isSuccess ? back : onClose}>{preview.isSuccess ? "Back" : "Cancel"}</button>
                {preview.isSuccess ? <button className="btn btn-primary" disabled={!acknowledged || busy || !!reset.error} onClick={() => target && reset.mutate({ target, confirmationToken: preview.data.confirmationToken, acknowledged: true })}><KeyRound size={16} />{reset.isPending ? "Resetting…" : `Reset ${preview.data.count} passwords`}</button> : <button className="btn btn-primary" disabled={busy || !count} onClick={review}>{preview.isPending ? "Checking students…" : "Review reset"}</button>}
              </div>
            </>
          )}
        </div>
      </dialog>
    </div>, document.body,
  );
}
