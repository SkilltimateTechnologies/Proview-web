// Shared design tokens + data helpers for generated PDFs (section report + student
// answer sheet). Kept framework-agnostic so both documents look identical.

export type ReportRow = {
  attemptId: string;
  studentId: string;
  name: string;
  rollNo: string;
  email: string | null;
  section: string;
  score: number | null;
  status: string;
  submittedAt: string | number | null;
  absent?: boolean;
  disconnected?: boolean;
  answeredCount?: number;
};

export type Brand = {
  collegeName: string;
  logoUrl: string; // absolute URL to the Skilltimate logo (same-origin png)
  accent: string; // tenant primary colour
};

export const C = {
  ink: "#1A2332",
  ink2: "#475467",
  muted: "#98A2B3",
  line: "#E4E7EC",
  soft: "#F7F9FC",
  white: "#FFFFFF",
  green: "#2E7D5B",
  greenSoft: "#E7F5EE",
  amber: "#B7791F",
  amberSoft: "#FBF3E4",
  red: "#C0453B",
  redSoft: "#FBECEB",
  blue: "#1A3EBF",
  blueSoft: "#EEF3FF",
  gold: "#C9A227",
  silver: "#8B93A1",
  bronze: "#B07A3C",
};

/** Dense-ranked top performers: rank increments only when the score changes, so
 * students with identical scores share a position. Everyone with rank <= 3 is
 * returned — ties can therefore yield more than three students. */
export function topPerformers(rows: ReportRow[]): (ReportRow & { rank: number })[] {
  const present = rows
    .filter((r) => !r.absent && r.score != null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  let rank = 0;
  let last: number | null = null;
  const ranked = present.map((r) => {
    if (r.score !== last) {
      rank += 1;
      last = r.score;
    }
    return { ...r, rank };
  });
  return ranked.filter((r) => r.rank <= 3);
}

/** Full dense ranking for the roster table (present students only). */
export function rankAll(rows: ReportRow[]): Map<string, number> {
  const present = rows
    .filter((r) => !r.absent && r.score != null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const map = new Map<string, number>();
  let rank = 0;
  let last: number | null = null;
  for (const r of present) {
    if (r.score !== last) {
      rank += 1;
      last = r.score;
    }
    map.set(r.attemptId, rank);
  }
  return map;
}

/** Ten score buckets across 0–100 for the distribution chart. */
export function scoreBuckets(rows: ReportRow[]): { label: string; count: number }[] {
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    label: i === 9 ? "90-100" : `${i * 10}-${i * 10 + 9}`,
    count: 0,
  }));
  for (const r of rows) {
    if (r.absent || r.score == null) continue;
    const idx = Math.min(9, Math.max(0, Math.floor(r.score / 10)));
    buckets[idx].count += 1;
  }
  return buckets;
}

export function bandCounts(rows: ReportRow[]): { label: string; count: number; color: string }[] {
  const present = rows.filter((r) => !r.absent && r.score != null);
  const bands = [90, 80, 70, 60, 50];
  const palette = ["#2E7D5B", "#3E8E5F", "#7A9E3A", "#B7791F", "#C0453B"];
  return bands.map((min, i) => ({
    label: `${min}%+`,
    count: present.filter((r) => (r.score ?? 0) >= min).length,
    color: palette[i],
  }));
}

export type SummaryStats = {
  total: number;
  present: number;
  absent: number;
  highest: number | null;
  lowest: number | null;
  average: number | null;
  passCount: number; // score >= passMark
  passRate: number | null;
  failCount: number; // wrote the exam but score < passMark
  failRate: number | null;
  passMark: number;
};

export function summarize(rows: ReportRow[], passMark = 40): SummaryStats {
  const present = rows.filter((r) => !r.absent && r.score != null);
  const scores = present.map((r) => r.score as number);
  const total = rows.length;
  const passCount = scores.filter((s) => s >= passMark).length;
  const failCount = scores.filter((s) => s < passMark).length;
  return {
    total,
    present: present.length,
    absent: rows.filter((r) => r.absent).length,
    highest: scores.length ? Math.max(...scores) : null,
    lowest: scores.length ? Math.min(...scores) : null,
    average: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
    passCount,
    passRate: present.length ? Math.round((passCount / present.length) * 1000) / 10 : null,
    failCount,
    failRate: present.length ? Math.round((failCount / present.length) * 1000) / 10 : null,
    passMark,
  };
}

export function fmtDate(t: string | number | null | undefined): string {
  if (!t) return "\u2014";
  return new Date(t).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

export function sanitizeFile(s: string): string {
  return s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "report";
}

/** Filesystem-safe but human-readable: keeps spaces and hyphens, strips only
 *  characters that are illegal in file names (/ \ : * ? " < > |). */
export function safeName(s: string): string {
  return s
    .replace(/[/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "report";
}

/** Compact date for file names, e.g. "Jan 10-2026" (IST). */
export function fmtFileDate(t: string | number | null | undefined): string {
  const d = t ? new Date(t) : new Date();
  const mon = d.toLocaleString("en-IN", { month: "short", timeZone: "Asia/Kolkata" });
  const day = d.toLocaleString("en-IN", { day: "2-digit", timeZone: "Asia/Kolkata" });
  const year = d.toLocaleString("en-IN", { year: "numeric", timeZone: "Asia/Kolkata" });
  return `${mon} ${day}-${year}`;
}
