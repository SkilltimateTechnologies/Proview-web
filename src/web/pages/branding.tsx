import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { Upload } from "lucide-react";
import { PageHeader } from "../components/shell";
import { Loader, Field, ColorPicker } from "../components/ui";

export default function Branding() {
  const qc = useQueryClient();
  const { refresh } = useSession();
  const q = useQuery({ queryKey: ["branding"], queryFn: async () => (await api.branding.$get()).json() });
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#1e3a5f");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    const t = q.data?.tenant;
    if (t) {
      setName(t.name);
      setShortName(t.shortName);
      setPrimaryColor(t.primaryColor);
      setLogoUrl(t.logoUrl);
    }
  }, [q.data]);

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
    mutationFn: async () => api.branding.$patch({ json: { name, shortName, primaryColor, logoUrl } }),
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["branding"] });
      await refresh();
    },
  });

  if (q.isLoading) return <Loader />;

  return (
    <div className="rise max-w-xl">
      <PageHeader eyebrow="Appearance" title="Branding" />
      <div className="card p-5 space-y-4">
        <div className="flex items-center gap-4">
          {logoUrl ? (
            <img src={logoUrl} alt="" className="h-16 w-16 rounded-xl object-cover border border-[var(--color-line)]" />
          ) : (
            <div className="h-16 w-16 rounded-xl flex items-center justify-center text-white font-bold text-lg" style={{ background: primaryColor, fontFamily: "var(--font-mono)" }}>{shortName || "GR"}</div>
          )}
          <div>
            <div className="mono-label mb-1.5">College logo</div>
            <label className="btn btn-ghost cursor-pointer">
              <Upload size={15} /> {logoUrl ? "Replace logo" : "Upload logo"}
              <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onLogo(f); }} />
            </label>
            <div className="text-xs text-[var(--color-muted)] mt-1">{uploading ? "Uploading…" : "PNG or SVG, square works best."}</div>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="College name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Short code"><input className="input" value={shortName} maxLength={3} onChange={(e) => setShortName(e.target.value.toUpperCase())} /></Field>
        </div>

        <div>
          <div className="mono-label mb-2">Primary color</div>
          <ColorPicker value={primaryColor} onChange={setPrimaryColor} />
        </div>

        <button className="btn btn-primary" style={{ background: primaryColor }} disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save branding"}
        </button>
      </div>
    </div>
  );
}
