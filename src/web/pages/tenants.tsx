import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, X, Building2, Pencil } from "lucide-react";
import { api } from "../lib/api";
import { PageHeader } from "../components/shell";
import { Loader, EmptyState, Pill, Field, ColorPicker, usePagination, Pager } from "../components/ui";

type Tenant = {
  id: string;
  name: string;
  shortName: string;
  slug: string;
  logoUrl: string | null;
  primaryColor: string;
  enabled: boolean;
  // Capacity ceilings. null = inherit the platform default (which itself
  // defaults to unlimited). See api/lib/tenant-quota.ts.
  maxConcurrentAttempts: number | null;
  maxEvidencePerAttempt: number | null;
  userCount: number;
};

/** "" and 0 mean "inherit", never "ceiling of zero" — the API normalises the same way. */
function quotaValue(v: string): number | null {
  const n = Math.floor(Number(v));
  return v.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
}

export default function Tenants() {
  const qc = useQueryClient();
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<Tenant | null>(null);
  const q = useQuery({ queryKey: ["tenants"], queryFn: async () => (await api.tenants.$get()).json() as Promise<{ tenants: Tenant[] }> });

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => api.tenants[":id"].$patch({ param: { id }, json: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenants"] }),
  });

  const pg = usePagination(q.data?.tenants ?? []);

  return (
    <div className="rise">
      <PageHeader eyebrow="Platform" title="Colleges" action={<button className="btn btn-primary" onClick={() => { setEdit(null); setAdd(true); }}><Plus size={16} /> Add college</button>} />
      {(add || edit) && <TenantForm key={edit?.id ?? "new"} tenant={edit ?? undefined} onClose={() => { setAdd(false); setEdit(null); }} />}
      {q.isLoading ? (
        <Loader />
      ) : !q.data?.tenants.length ? (
        <EmptyState title="No colleges yet" hint="Onboard a college to create its portal." />
      ) : (
        <>
        <div className="grid sm:grid-cols-2 gap-4">
          {pg.pageItems.map((t) => (
            <div key={t.id} className="card p-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="h-11 w-11 rounded-lg flex items-center justify-center text-white font-bold" style={{ background: t.primaryColor, fontFamily: "var(--font-mono)" }}>{t.shortName}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[var(--color-ink)] truncate">{t.name}</div>
                  <div className="mono-label">{t.userCount} staff · /{t.slug}</div>
                </div>
                <button className="btn btn-ghost !px-2.5" onClick={() => { setAdd(false); setEdit(t); }} title="Edit college"><Pencil size={15} /></button>
              </div>
              <div className="flex items-center justify-between">
                <Pill label={t.enabled ? "Active" : "Suspended"} color={t.enabled ? "#2e7d5b" : "#c0453b"} />
                <button className={t.enabled ? "btn btn-danger" : "btn btn-ghost"} onClick={() => toggle.mutate({ id: t.id, enabled: !t.enabled })}>
                  {t.enabled ? "Suspend" : "Activate"}
                </button>
              </div>
            </div>
          ))}
        </div>
        <Pager {...pg} onChange={pg.setPage} unit="colleges" />
        </>
      )}
    </div>
  );
}

function TenantForm({ tenant, onClose }: { tenant?: Tenant; onClose: () => void }) {
  const qc = useQueryClient();
  const editing = !!tenant;
  const [name, setName] = useState(tenant?.name ?? "");
  const [shortName, setShortName] = useState(tenant?.shortName ?? "");
  const [primaryColor, setPrimaryColor] = useState(tenant?.primaryColor ?? "#1e3a5f");
  const [maxLive, setMaxLive] = useState(tenant?.maxConcurrentAttempts ? String(tenant.maxConcurrentAttempts) : "");
  const [maxEvidence, setMaxEvidence] = useState(tenant?.maxEvidencePerAttempt ? String(tenant.maxEvidencePerAttempt) : "");

  useEffect(() => {
    if (tenant) {
      setName(tenant.name);
      setShortName(tenant.shortName);
      setPrimaryColor(tenant.primaryColor);
      setMaxLive(tenant.maxConcurrentAttempts ? String(tenant.maxConcurrentAttempts) : "");
      setMaxEvidence(tenant.maxEvidencePerAttempt ? String(tenant.maxEvidencePerAttempt) : "");
    }
  }, [tenant]);

  const save = useMutation({
    mutationFn: async () => {
      if (editing)
        return api.tenants[":id"].$patch({
          param: { id: tenant!.id },
          json: {
            name,
            shortName,
            primaryColor,
            logoUrl: null,
            maxConcurrentAttempts: quotaValue(maxLive),
            maxEvidencePerAttempt: quotaValue(maxEvidence),
          },
        });
      return api.tenants.$post({ json: { name, shortName, primaryColor, logoUrl: null } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenants"] });
      onClose();
    },
  });

  return (
    <div className="card p-5 mb-5">
      <div className="flex items-center justify-between mb-4">
        <div className="font-semibold flex items-center gap-2"><Building2 size={18} /> {editing ? "Edit college" : "Add college"}</div>
        <button onClick={onClose}><X size={18} className="text-[var(--color-muted)]" /></button>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Short code"><input className="input" maxLength={8} value={shortName} onChange={(e) => setShortName(e.target.value.toUpperCase())} /></Field>
      </div>
      <div className="mt-4">
        <div className="mono-label mb-2">Primary color</div>
        <ColorPicker value={primaryColor} onChange={setPrimaryColor} />
      </div>

      {editing && (
        <div className="mt-5 border-t border-[var(--color-line)] pt-4">
          <div className="font-semibold text-sm mb-1">Capacity limits</div>
          <p className="text-xs text-[var(--color-ink2)] mb-3">
            Leave blank to inherit the platform default. These are load ceilings, not exam rules — a limit never
            interrupts a student already writing, and it never discards a proctoring violation. To stop a college
            entirely, suspend it instead.
          </p>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Max students writing at once">
              <input className="input" type="number" min={0} value={maxLive} onChange={(e) => setMaxLive(e.target.value)} placeholder="Unlimited" />
            </Field>
            <Field label="Max camera frames kept per attempt">
              <input className="input" type="number" min={0} value={maxEvidence} onChange={(e) => setMaxEvidence(e.target.value)} placeholder="Unlimited" />
            </Field>
          </div>
        </div>
      )}
      <button className="btn btn-primary mt-4" disabled={save.isPending || !name} onClick={() => save.mutate()}>
        {save.isPending ? "Saving…" : editing ? "Save changes" : "Create college"}
      </button>
    </div>
  );
}
