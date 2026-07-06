import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard,
  Activity,
  FileBarChart,
  CalendarClock,
  Library,
  Layers,
  Users,
  Settings,
  Palette,
  Building2,
  LogOut,
  MoreHorizontal,
  ArrowLeftRight,
  Check,
  X,
} from "lucide-react";
import { useSession, allowed, type Me } from "../lib/session";
import { api, getScope, setScope } from "../lib/api";

type NavDef = { path: string; label: string; icon: React.ElementType; module: string; superOnly?: boolean };

const NAV: NavDef[] = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard, module: "dashboard" },
  { path: "/monitor", label: "Live Monitor", icon: Activity, module: "liveMonitor" },
  { path: "/reports", label: "Reports", icon: FileBarChart, module: "reports" },
  { path: "/exams", label: "Schedule Assessment", icon: CalendarClock, module: "exams" },
  { path: "/questions", label: "Question Bank", icon: Library, module: "questionBank" },
  { path: "/users", label: "Users", icon: Users, module: "users" },
  { path: "/sections", label: "Sections", icon: Layers, module: "users" },
  { path: "/settings", label: "Settings", icon: Settings, module: "settings", superOnly: true },
  { path: "/branding", label: "Branding", icon: Palette, module: "branding" },
  { path: "/tenants", label: "Colleges", icon: Building2, module: "tenants", superOnly: true },
];

function visibleNav(me: Me | null): NavDef[] {
  return NAV.filter((n) => {
    if (n.superOnly) return me?.profile.role === "super_admin";
    return allowed(me, n.module);
  });
}

/** Identity badge: Skilltimate logo with the college name below it. */
function CollegeBadge({ me }: { me: Me | null }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <img src="/skilltimate-logo.png" alt="Skilltimate" className="h-8 w-auto max-w-[170px] object-contain object-left" />
      <div className="font-semibold text-[14px] leading-tight text-[var(--color-ink)] truncate">{me?.tenant?.name ?? "Proview"}</div>
    </div>
  );
}

/**
 * Super-admin workspace switcher. Shows the ACTIVE college as the primary
 * identity (logo + name) with a small switch icon. No duplicate college name.
 * Always resolves to a real college — never "All colleges".
 */
function WorkspaceSwitcher({ me }: { me: Me | null }) {
  const qc = useQueryClient();
  const { refresh } = useSession();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ["tenants"], queryFn: async () => (await api.tenants.$get()).json() });
  const scope = getScope();
  const tenants = q.data && "tenants" in q.data ? q.data.tenants : [];

  // Default to the first college whenever nothing valid is selected.
  useEffect(() => {
    if (!tenants.length) return;
    const valid = tenants.some((t) => t.id === scope);
    if (!valid) {
      setScope(tenants[0].id);
      refresh();
      qc.invalidateQueries();
    }
  }, [tenants, scope, refresh, qc]);

  // Prefer live tenant list; fall back to session tenant for logo/name.
  const active = tenants.find((t) => t.id === scope) ?? (me?.tenant ? { id: me.tenant.id, name: me.tenant.name, shortName: me.tenant.shortName, primaryColor: me.tenant.primaryColor, logoUrl: me.tenant.logoUrl } : null);

  async function pick(tenantId: string) {
    setScope(tenantId);
    setOpen(false);
    await refresh();
    qc.invalidateQueries();
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="group w-full flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left hover:bg-[var(--color-brand-soft)] transition"
      >
        <div className="flex flex-col gap-1.5 min-w-0 flex-1">
          <img src="/skilltimate-logo.png" alt="Skilltimate" className="h-8 w-auto max-w-[160px] object-contain object-left" />
          <div className="font-semibold text-[14px] leading-tight text-[var(--color-ink)] truncate">{active?.name ?? "Select college"}</div>
        </div>
        <span className="shrink-0 h-6 w-6 rounded-md flex items-center justify-center text-[var(--color-muted)] group-hover:bg-white group-hover:text-[var(--brand)] transition" title="Switch college">
          <ArrowLeftRight size={14} />
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute z-30 left-0 right-0 mt-1 rounded-lg border border-[var(--color-line)] bg-white shadow-lg py-1 max-h-80 overflow-y-auto">
            <div className="mono-label px-3 pt-1.5 pb-1">Switch college</div>
            {tenants.map((t) => (
              <button key={t.id} onClick={() => pick(t.id)} className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--color-brand-soft)]">
                <div className="h-6 w-6 rounded flex items-center justify-center text-white text-[10px] font-bold shrink-0" style={{ background: t.primaryColor, fontFamily: "var(--font-mono)" }}>{t.shortName}</div>
                <span className="flex-1 text-left text-[var(--color-ink)] truncate">{t.name}</span>
                {scope === t.id && <Check size={15} className="text-[var(--brand)]" />}
              </button>
            ))}
            {!tenants.length && <div className="px-3 py-2 text-sm text-[var(--color-muted)]">No colleges yet</div>}
          </div>
        </>
      )}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { me, signOut } = useSession();
  const [loc] = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const nav = visibleNav(me);
  const brand = me?.tenant?.primaryColor ?? "#1e3a5f";
  const isSuper = me?.profile.role === "super_admin";

  const primary = nav.slice(0, 4);
  const overflow = nav.slice(4);

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ "--brand": brand } as React.CSSProperties}>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-[240px] flex-col border-r border-[var(--color-line)] bg-white px-4 py-5">
        <div className="px-1">
          {isSuper ? <WorkspaceSwitcher me={me} /> : <div className="px-1"><CollegeBadge me={me} /></div>}
        </div>
        <nav className="mt-8 flex-1 space-y-1 overflow-y-auto">
          {nav.map((n) => {
            const active = loc === n.path;
            const Icon = n.icon;
            return (
              <Link key={n.path} to={n.path} className={`nav-item ${active ? "active" : ""}`}>
                <Icon size={18} strokeWidth={2} />
                <span>{n.label}</span>
              </Link>
            );
          })}
        </nav>
        <button onClick={signOut} className="nav-item mt-2 text-[var(--color-danger)]">
          <LogOut size={18} />
          <span>Sign out</span>
        </button>
      </aside>

      {/* Mobile top bar */}
      <header className="md:hidden sticky top-0 z-20 flex items-center justify-between border-b border-[var(--color-line)] bg-white px-4 py-3">
        {isSuper ? <div className="flex-1 min-w-0 mr-2"><WorkspaceSwitcher me={me} /></div> : <CollegeBadge me={me} />}
        <button onClick={signOut} className="shrink-0 text-sm font-semibold text-[var(--brand)]">
          Sign out
        </button>
      </header>

      {/* Main */}
      <main className="flex-1 flex flex-col md:pl-[240px] pb-24 md:pb-0">
        <div className="flex-1 w-full mx-auto max-w-[1440px] px-5 md:px-8 py-6 md:py-8">{children}</div>
      </main>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-20 grid grid-cols-5 border-t border-[var(--color-line)] bg-white">
        {primary.map((n) => {
          const active = loc === n.path;
          const Icon = n.icon;
          return (
            <Link key={n.path} to={n.path} className="flex flex-col items-center gap-1 py-2.5" style={{ color: active ? brand : "var(--color-muted)" }}>
              <Icon size={20} />
              <span className="text-[10px] font-medium">{n.label.split(" ")[0]}</span>
            </Link>
          );
        })}
        <button onClick={() => setMoreOpen(true)} className="flex flex-col items-center gap-1 py-2.5 text-[var(--color-muted)]">
          <MoreHorizontal size={20} />
          <span className="text-[10px] font-medium">More</span>
        </button>
      </nav>

      {/* Mobile more sheet */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-30 bg-black/30" onClick={() => setMoreOpen(false)}>
          <div className="absolute bottom-0 inset-x-0 rounded-t-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="eyebrow">More</div>
              <button onClick={() => setMoreOpen(false)}>
                <X size={20} className="text-[var(--color-muted)]" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {overflow.map((n) => {
                const Icon = n.icon;
                return (
                  <Link key={n.path} to={n.path} onClick={() => setMoreOpen(false)} className="flex flex-col items-center gap-2 rounded-xl border border-[var(--color-line)] py-4">
                    <Icon size={20} className="text-[var(--brand)]" />
                    <span className="text-xs font-medium text-center text-[var(--color-ink)]">{n.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function PageHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3 mb-6">
      <div className="min-w-0">
        <div className="eyebrow mb-1">{eyebrow}</div>
        <h1 className="page-title">{title}</h1>
      </div>
      {action && <div className="flex flex-wrap gap-2 lg:justify-end min-w-0">{action}</div>}
    </div>
  );
}
