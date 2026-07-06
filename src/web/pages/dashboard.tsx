import { useQuery } from "@tanstack/react-query";
import { GraduationCap } from "lucide-react";
import { Link } from "wouter";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, ResponsiveContainer, CartesianGrid } from "recharts";
import { api } from "../lib/api";
import { useSession, allowed } from "../lib/session";
import { PageHeader } from "../components/shell";
import { StatCard, Loader, Pill, EmptyState } from "../components/ui";

export default function Dashboard() {
  const { me } = useSession();
  const brand = me?.tenant?.primaryColor ?? "#1e3a5f";
  const canSchedule = allowed(me, "exams");
  const q = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => {
      const res = await api.dashboard.$get();
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
  });

  if (q.isLoading) return <Loader />;
  const d = q.data;
  if (!d?.stats)
    return (
      <div className="rise">
        <PageHeader
          eyebrow="Institution analytics"
          title="Dashboard"
          action={
            canSchedule ? (
              <Link to="/exams" className="btn btn-primary">
                Schedule assessment
              </Link>
            ) : undefined
          }
        />
        <EmptyState title="No data yet" hint="Schedule and finish an assessment to see analytics." />
      </div>
    );

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Institution analytics"
        title="Dashboard"
        action={
          canSchedule ? (
            <Link to="/exams" className="btn btn-primary">
              Schedule assessment
            </Link>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard value={d.stats.totalStudents ?? 0} label="Students enrolled" icon={<GraduationCap size={16} />} />
        <StatCard value={d.stats.avg} label="Institution avg · semester" />
        <StatCard value={`${d.stats.passRate}%`} label="Pass rate · finished exams" />
        <StatCard value={d.stats.completed} label="Assessments completed" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <div className="card p-5">
          <div className="font-semibold text-[var(--color-ink)]">Class-wise average</div>
          <div className="mono-label mt-0.5 mb-4">Finished assessments · this semester</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={d.classAvg} margin={{ left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef0f3" />
              <XAxis dataKey="code" tick={{ fontSize: 12, fill: "#8a929c" }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "#8a929c" }} axisLine={false} tickLine={false} />
              <Bar dataKey="avg" fill={brand} radius={[6, 6, 0, 0]} maxBarSize={54} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-5">
          <div className="font-semibold text-[var(--color-ink)]">Average score trend</div>
          <div className="mono-label mt-0.5 mb-4">Across the last {d.trend.length} finished assessments</div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={d.trend} margin={{ left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef0f3" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#8a929c" }} axisLine={false} tickLine={false} />
              <YAxis domain={[40, 90]} tick={{ fontSize: 11, fill: "#8a929c" }} axisLine={false} tickLine={false} />
              <Line type="monotone" dataKey="avg" stroke={brand} strokeWidth={2.5} dot={{ r: 3, fill: brand }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <div className="card p-5">
          <div className="font-semibold text-[var(--color-ink)] mb-4">Top students · overall</div>
          <div className="space-y-1">
            {d.topStudents.map((s, i) => (
              <div key={s.rollNo + i} className="flex items-center gap-3 py-2 border-b border-[var(--color-line)] last:border-0">
                <span className="mono-label w-6">{String(i + 1).padStart(2, "0")}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-[var(--color-ink)] truncate">{s.name}</div>
                  <div className="text-xs text-[var(--color-muted)]" style={{ fontFamily: "var(--font-mono)" }}>
                    {s.classCode} · {s.rollNo}
                  </div>
                </div>
                <span className="stat-num text-[var(--color-ink)]">{s.avg}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card p-5">
          <div className="font-semibold text-[var(--color-ink)] mb-4">Class toppers</div>
          <div className="space-y-3">
            {d.classToppers.map((t) => (
              <div key={t.code} className="flex items-center justify-between gap-3">
                <Pill label={t.code} color={brand} />
                <div className="flex items-center gap-3 flex-1 justify-end">
                  <span className="font-medium text-[var(--color-ink)]">{t.name}</span>
                  <span className="stat-num text-[var(--color-ink)]">{t.score}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
