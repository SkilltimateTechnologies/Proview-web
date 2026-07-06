import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, X, Building2, Pencil, Upload } from "lucide-react";
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
  userCount: number;
};

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
                {t.logoUrl ? (
                  <img src={t.logoUrl} alt="" className="h-11 w-11 rounded-lg object-cover border border-[var(--color-line)]" />
                ) : (
                  <div className="h-11 w-11 rounded-lg flex items-center justify-center text-white font-bold" style={{ background: t.primaryColor, fontFamily: "var(--font-mono)" }}>{t.shortName}</div>
                )}
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
  const [logoUrl, setLogoUrl] = useState<string | null>(tenant?.logoUrl ?? null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (tenant) {
      setName(tenant.name);
      setShortName(tenant.shortName);
      setPrimaryColor(tenant.primaryColor);
      setLogoUrl(tenant.logoUrl);
    }
  }, [tenant]);

  async function onLogo(file: File) {
    setUploading(true);
    try {
      const presign = await (await api.upload.presign.$post({ json: { name: file.name, contentType: file.type } })).json();
      await fetch(presign.url, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      setLogoUrl(presign.publicUrl);
    } finally {
      setUploading(false);
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      if (editing) return api.tenants[":id"].$patch({ param: { id: tenant!.id }, json: { name, shortName, primaryColor, logoUrl } });
      return api.tenants.$post({ json: { name, shortName, primaryColor, logoUrl } });
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

      <div className="flex items-center gap-4 mb-4">
        {logoUrl ? (
          <img src={logoUrl} alt="" className="h-14 w-14 rounded-xl object-cover border border-[var(--color-line)]" />
        ) : (
          <div className="h-14 w-14 rounded-xl flex items-center justify-center text-white font-bold" style={{ background: primaryColor, fontFamily: "var(--font-mono)" }}>{shortName || "GR"}</div>
        )}
        <div>
          <div className="mono-label mb-1.5">College logo</div>
          <label className="btn btn-ghost cursor-pointer">
            <Upload size={15} /> {logoUrl ? "Replace logo" : "Upload logo"}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onLogo(f); }} />
          </label>
          {uploading && <div className="text-xs text-[var(--color-muted)] mt-1">Uploading…</div>}
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Short code"><input className="input" maxLength={3} value={shortName} onChange={(e) => setShortName(e.target.value.toUpperCase())} /></Field>
      </div>
      <div className="mt-4">
        <div className="mono-label mb-2">Primary color</div>
        <ColorPicker value={primaryColor} onChange={setPrimaryColor} />
      </div>
      <button className="btn btn-primary mt-4" disabled={save.isPending || !name} onClick={() => save.mutate()}>
        {save.isPending ? "Saving…" : editing ? "Save changes" : "Create college"}
      </button>
    </div>
  );
}
