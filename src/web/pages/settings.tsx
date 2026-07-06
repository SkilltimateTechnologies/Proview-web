import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/shell";
import { Loader, Field } from "../components/ui";

type ProctorConfig = {
  requireWebcam: boolean;
  requireInternet: boolean;
  blockOnCameraLoss: boolean;
  cameraLossLockSeconds: number;
  fullscreenRequired: boolean;
  blockCopyPaste: boolean;
  flagTabSwitch: boolean;
  maxTabSwitches: number;
  webcamSnapshots: boolean;
  snapshotIntervalSec: number;
  requireSingleScreen: boolean;
  blockScreenshots: boolean;
  autoSubmitOnTimeout: boolean;
};

type S = {
  aiProvider: string;
  judge0Key: string | null;
  claudeKey: string | null;
  geminiKey: string | null;
  openaiKey: string | null;
  judge0Limit: number;
  judge0Used: number;
  aiLimit: number;
  aiUsed: number;
  proctoring: ProctorConfig;
};

function Toggle({ label, sub, checked, onChange }: { label: string; sub?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start justify-between gap-4 py-3 cursor-pointer border-b border-[var(--color-line)] last:border-0">
      <span className="min-w-0">
        <span className="block font-medium text-sm">{label}</span>
        {sub && <span className="block text-xs text-[var(--color-ink2)] mt-0.5">{sub}</span>}
      </span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`shrink-0 mt-0.5 w-11 h-6 rounded-full transition-colors relative ${checked ? "bg-[var(--color-brand)]" : "bg-gray-300"}`}
        aria-pressed={checked}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : ""}`} />
      </button>
    </label>
  );
}

function ChangePassword() {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const res = await api["change-password"].$post({ json: { currentPassword: cur, newPassword: next } });
      const data = (await res.json()) as { ok?: boolean; message?: string };
      if (!res.ok) throw new Error(data.message ?? "Failed to change password");
      return data;
    },
    onSuccess: () => {
      setMsg({ ok: true, text: "Password updated successfully." });
      setCur(""); setNext(""); setConfirm("");
    },
    onError: (e: Error) => setMsg({ ok: false, text: e.message }),
  });

  const submit = () => {
    setMsg(null);
    if (next.length < 8) return setMsg({ ok: false, text: "New password must be at least 8 characters." });
    if (next !== confirm) return setMsg({ ok: false, text: "New passwords do not match." });
    save.mutate();
  };

  return (
    <div className="card p-5 mb-5 space-y-4">
      <div>
        <div className="font-semibold">Change password</div>
        <p className="text-xs text-[var(--color-ink2)] mt-0.5">Update the password for your admin account.</p>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Current password"><input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} placeholder="••••••••" autoComplete="current-password" /></Field>
        <div className="hidden sm:block" />
        <Field label="New password"><input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" /></Field>
        <Field label="Confirm new password"><input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter new password" autoComplete="new-password" /></Field>
      </div>
      {msg && <div className={`text-sm ${msg.ok ? "text-green-600" : "text-red-600"}`}>{msg.text}</div>}
      <button className="btn btn-primary" disabled={save.isPending || !cur || !next || !confirm} onClick={submit}>
        {save.isPending ? "Updating…" : "Update password"}
      </button>
    </div>
  );
}

export default function Settings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: async () => (await api.settings.$get()).json() as Promise<{ settings: S | null }> });
  const [form, setForm] = useState<Partial<S>>({});

  useEffect(() => {
    if (q.data?.settings) setForm(q.data.settings);
  }, [q.data]);

  const save = useMutation({
    mutationFn: async () => api.settings.$patch({ json: form }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings", "dashboard"] }),
  });

  if (q.isLoading) return <Loader />;
  const s = q.data?.settings;

  const DEFAULT_PROCTORING: ProctorConfig = {
    requireWebcam: true, requireInternet: true, blockOnCameraLoss: true, cameraLossLockSeconds: 120,
    fullscreenRequired: true, blockCopyPaste: true, flagTabSwitch: true, maxTabSwitches: 0,
    webcamSnapshots: false, snapshotIntervalSec: 30,
    requireSingleScreen: true, blockScreenshots: true, autoSubmitOnTimeout: true,
  };
  const pc: ProctorConfig = { ...DEFAULT_PROCTORING, ...(form.proctoring ?? {}) };
  const setPc = (patch: Partial<ProctorConfig>) => setForm((f) => ({ ...f, proctoring: { ...DEFAULT_PROCTORING, ...(f.proctoring ?? {}), ...patch } }));

  return (
    <div className="rise max-w-2xl">
      <PageHeader eyebrow="Configuration" title="Settings" />

      <ChangePassword />

      <div className="card p-5 mb-5">
        <div className="font-semibold mb-1">Camera &amp; monitoring</div>
        <p className="text-xs text-[var(--color-ink2)] mb-2">Global proctoring rules that Proview enforces inside the exam.</p>
        <div className="text-[11px] leading-relaxed text-[var(--color-ink2)] bg-[var(--color-bg2,#f6f7fb)] border border-[var(--color-line)] rounded-lg p-3 mb-4">
          Lockdown (fullscreen, disabling copy/paste, blocking screenshots, tab &amp; window switching,
          extra monitors) is handled automatically by the secure exam browser at the operating-system level —
          it can&apos;t be turned off here and needs no configuration. The settings below are the extra
          camera and monitoring rules that only Proview controls.
        </div>

        {/* --- Camera --- */}
        <div className="text-[11px] font-semibold tracking-wide uppercase text-[var(--color-ink2)] mb-1">Camera</div>
        <Toggle label="Require webcam" sub="Block starting the exam until the webcam is active. Camera stays on the whole exam." checked={pc.requireWebcam} onChange={(v) => setPc({ requireWebcam: v })} />
        {pc.requireWebcam && (
          <Toggle label="Lock exam if camera is closed" sub="If the student disables/closes the camera mid-exam, freeze the exam temporarily." checked={pc.blockOnCameraLoss} onChange={(v) => setPc({ blockOnCameraLoss: v })} />
        )}
        {pc.requireWebcam && pc.blockOnCameraLoss && (
          <Field label="Camera-loss lock duration (seconds)">
            <input className="input" type="number" min={10} value={pc.cameraLossLockSeconds} onChange={(e) => setPc({ cameraLossLockSeconds: Number(e.target.value) })} />
          </Field>
        )}
        {pc.requireWebcam && (
          <Toggle label="Periodic webcam snapshots" sub="Capture a webcam photo at intervals during the exam." checked={pc.webcamSnapshots} onChange={(v) => setPc({ webcamSnapshots: v })} />
        )}
        {pc.requireWebcam && pc.webcamSnapshots && (
          <Field label="Snapshot interval (seconds)">
            <input className="input" type="number" min={5} value={pc.snapshotIntervalSec} onChange={(e) => setPc({ snapshotIntervalSec: Number(e.target.value) })} />
          </Field>
        )}

        {/* --- Connection & auto-actions --- */}
        <div className="text-[11px] font-semibold tracking-wide uppercase text-[var(--color-ink2)] mt-5 mb-1">Connection &amp; auto-actions</div>
        <Toggle label="Require internet to start" sub="A live connection is needed to begin and to sync answers during the exam." checked={pc.requireInternet} onChange={(v) => setPc({ requireInternet: v })} />

        {/* --- Timer --- */}
        <div className="text-[11px] font-semibold tracking-wide uppercase text-[var(--color-ink2)] mt-5 mb-1">Timer</div>
        <Toggle label="Auto-submit when timer hits zero" sub="Force-submit the exam the moment the countdown reaches 0. Turn off to let students keep the screen open past time." checked={pc.autoSubmitOnTimeout} onChange={(v) => setPc({ autoSubmitOnTimeout: v })} />

        <div className="pt-4">
          <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save proctoring rules"}
          </button>
        </div>
      </div>

      <div className="card p-5 space-y-4">
        <div className="font-semibold">API keys & limits</div>
        <Field label="AI provider">
          <select className="input" value={form.aiProvider ?? "anthropic"} onChange={(e) => setForm((f) => ({ ...f, aiProvider: e.target.value }))}>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="google">Google (Gemini)</option>
            <option value="openai">OpenAI (GPT)</option>
          </select>
        </Field>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Claude key"><input className="input" value={form.claudeKey ?? ""} onChange={(e) => setForm((f) => ({ ...f, claudeKey: e.target.value }))} placeholder="sk-ant-…" /></Field>
          <Field label="Gemini key"><input className="input" value={form.geminiKey ?? ""} onChange={(e) => setForm((f) => ({ ...f, geminiKey: e.target.value }))} placeholder="AI…" /></Field>
          <Field label="OpenAI key"><input className="input" value={form.openaiKey ?? ""} onChange={(e) => setForm((f) => ({ ...f, openaiKey: e.target.value }))} placeholder="sk-…" /></Field>
          <Field label="Judge0 key"><input className="input" value={form.judge0Key ?? ""} onChange={(e) => setForm((f) => ({ ...f, judge0Key: e.target.value }))} placeholder="RapidAPI key" /></Field>
          <Field label="Judge0 limit"><input className="input" type="number" value={form.judge0Limit ?? 0} onChange={(e) => setForm((f) => ({ ...f, judge0Limit: Number(e.target.value) }))} /></Field>
          <Field label="AI limit"><input className="input" type="number" value={form.aiLimit ?? 0} onChange={(e) => setForm((f) => ({ ...f, aiLimit: Number(e.target.value) }))} /></Field>
        </div>
        <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}

// usage meters removed
