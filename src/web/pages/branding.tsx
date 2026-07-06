import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { PageHeader } from "../components/shell";
import { Loader, Field, ColorPicker } from "../components/ui";

export default function Branding() {
  const qc = useQueryClient();
  const { refresh } = useSession();
  const q = useQuery({ queryKey: ["branding"], queryFn: async () => (await api.branding.$get()).json() });
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#1e3a5f");

  useEffect(() => {
    const t = q.data?.tenant;
    if (t) {
      setName(t.name);
      setShortName(t.shortName);
      setPrimaryColor(t.primaryColor);
    }
  }, [q.data]);

  const save = useMutation({
    mutationFn: async () => api.branding.$patch({ json: { name, shortName, primaryColor, logoUrl: null } }),
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
          <img src="/skilltimate-logo.png" alt="Skilltimate" className="h-10 w-auto max-w-[190px] object-contain" />
          <div className="text-xs text-[var(--color-muted)]">The Skilltimate logo appears across the portal, with your college name shown beneath it.</div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="College name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Short code"><input className="input" value={shortName} maxLength={8} onChange={(e) => setShortName(e.target.value.toUpperCase())} /></Field>
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
