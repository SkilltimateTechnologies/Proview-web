import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import {
  AlarmClockIcon,
  BadgeCheckIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CircleCheckBigIcon,
  ClockIcon,
  CloudOffIcon,
  EyeIcon,
  EyeOffIcon,
  FileSearchIcon,
  FlagIcon,
  InboxIcon,
  InfoIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LightbulbIcon,
  LoaderCircleIcon,
  LockIcon,
  LogInIcon,
  LogOutIcon,
  MonitorIcon,
  MonitorXIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
  SendIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TargetIcon,
  TerminalIcon,
  TimerIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  UserXIcon,
  VideoIcon,
  VideoOffIcon,
  WifiIcon,
  WifiOffIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * Every icon the student app AND the public registration page (which imports this
 * component) render, by kebab-case name.
 *
 * This used to be `import * as Lucide from "lucide-react"` plus a lookup by name,
 * which defeats tree-shaking: the whole icon library (~1,600 icons, ~940 KB of
 * source) went into the entry bundle EVERY student downloads,
 * served by the same process answering their heartbeats. Listing the icons cuts
 * that chunk to about a third. A name missing from this map renders nothing, as
 * an unknown name always did; `ui.test.ts` fails the build if the student app
 * uses a name that is not listed here.
 */
export const STUDENT_ICONS: Record<string, LucideIcon> = {
  "alarm-clock": AlarmClockIcon,
  "badge-check": BadgeCheckIcon,
  "arrow-left": ArrowLeftIcon,
  "arrow-right": ArrowRightIcon,
  "check": CheckIcon,
  "circle-check-big": CircleCheckBigIcon,
  "clock": ClockIcon,
  "cloud-off": CloudOffIcon,
  "eye": EyeIcon,
  "eye-off": EyeOffIcon,
  "file-search": FileSearchIcon,
  "flag": FlagIcon,
  "inbox": InboxIcon,
  "info": InfoIcon,
  "key-round": KeyRoundIcon,
  "layout-dashboard": LayoutDashboardIcon,
  "lightbulb": LightbulbIcon,
  "loader-circle": LoaderCircleIcon,
  "lock": LockIcon,
  "log-in": LogInIcon,
  "log-out": LogOutIcon,
  "monitor": MonitorIcon,
  "monitor-x": MonitorXIcon,
  "pause": PauseIcon,
  "pencil": PencilIcon,
  "play": PlayIcon,
  "rotate-ccw": RotateCcwIcon,
  "send": SendIcon,
  "shield-alert": ShieldAlertIcon,
  "shield-check": ShieldCheckIcon,
  "sparkles": SparklesIcon,
  "target": TargetIcon,
  "terminal": TerminalIcon,
  "timer": TimerIcon,
  "triangle-alert": TriangleAlertIcon,
  "user-round": UserRoundIcon,
  "user-x": UserXIcon,
  "video": VideoIcon,
  "video-off": VideoOffIcon,
  "wifi": WifiIcon,
  "wifi-off": WifiOffIcon,
  "x": XIcon,
};

// Kebab-case name -> Lucide component wrapper (matches web app convention).
export function Icon({ name, size = 16, className, style }: { name: string; size?: number; className?: string; style?: CSSProperties }) {
  const Cmp = STUDENT_ICONS[name];
  if (!Cmp) return null;
  return <Cmp size={size} className={className} style={style} />;
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
