import { useEffect, useState, type ReactNode } from "react";
import * as Lucide from "lucide-react";

// Kebab-case name -> Lucide component wrapper (matches web app convention).
export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const pascal = name.split("-").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
  const Cmp = (Lucide as unknown as Record<string, React.ComponentType<{ size?: number; className?: string }>>)[pascal];
  if (!Cmp) return null;
  return <Cmp size={size} className={className} />;
}

export function Pill({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "success" | "warn" | "danger" | "brand" }) {
  const map: Record<string, React.CSSProperties> = {
    default: {},
    success: { background: "#e7f5ee", color: "var(--color-success)" },
    warn: { background: "#fdf3e2", color: "var(--color-warn)" },
    danger: { background: "var(--color-danger-bg)", color: "var(--color-danger)" },
    brand: { background: "var(--color-brand-soft)", color: "var(--brand)" },
  };
  return <span className="pill" style={map[tone]}>{children}</span>;
}

export function Loader({ label = "Loading…" }: { label?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: 60, color: "var(--color-ink2)" }}>
      <Icon name="loader-circle" className="animate-spin" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ icon = "inbox", title, sub }: { icon?: string; title: string; sub?: string }) {
  return (
    <div className="card" style={{ padding: 48, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--color-brand-soft)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--brand)", marginBottom: 4 }}>
        <Icon name={icon} size={24} />
      </div>
      <div style={{ fontWeight: 700, fontSize: 16 }}>{title}</div>
      {sub && <div style={{ color: "var(--color-ink2)", fontSize: 14, maxWidth: 380 }}>{sub}</div>}
    </div>
  );
}

// Live online/offline badge driven by navigator + window events.
export function useOnline() {
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

export function NetBadge({ online }: { online: boolean }) {
  return (
    <span className={`net-badge ${online ? "net-on" : "net-off"}`}>
      <Icon name={online ? "wifi" : "wifi-off"} size={14} />
      {online ? "Online" : "Offline"}
    </span>
  );
}
