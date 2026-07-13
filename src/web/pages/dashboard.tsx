import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GraduationCap, CalendarDays } from "lucide-react";
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
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const periodOn = !!(dateFrom || dateTo);
  const q = useQuery({
    queryKey: ["dashboard", dateFrom, dateTo],
    queryFn: async () => {
      const res = await api.dashboard.$get({ query: { from: dateFrom || undefined, to: dateTo || undefined } });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
  });

  const periodLabel = periodOn ? "selected period" : "all time";
  const filterBar = (
    <div className="card p-3 mb-4 flex flex-wrap items-center gap-2">
      <span className="mono-label mr-1">Period</span>
      <div className="flex items-center gap-1.5">
        <CalendarDays size={15} className="text-[var(--color-muted)]" />
        <input type="date" className="input w-auto" aria-label="From date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} />
        <span className="text-[var(--color-muted)] text-sm">–</span>
        <input type="date" className="input w-auto" aria-label="To date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} />
      </div>
      {periodOn && (
        <button className="btn-ghost text-sm" onClick={() => { setDateFrom(""); setDateTo(""); }}>Clear</button>
      )}
    </div>
  );

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
        {filterBar}
        <EmptyState
          title={periodOn ? "No data for this period" : "No data yet"}
          hint={periodOn ? "Try widening the date range or clearing the filter." : "Schedule and finish an assessment to see analytics."}
        />
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

      {filterBar}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard value={d.stats.totalStudents ?? 0} label="Students" icon={<GraduationCap size={16} />} />
        <StatCard value={d.stats.avg} label={`Institution avg · ${periodLabel}`} />
        <StatCard value={`${d.stats.passRate}%`} label="Pass rate · finished exams" />
        <StatCard value={d.stats.completed} label="Assessments completed" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <div className="card p-5">
          <div className="font-semibold text-[var(--color-ink)]">Class-wise average</div>
          <div className="mono-label mt-0.5 mb-4">Finished assessments · {periodLabel}</div>
          {d.classAvg.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={d.classAvg} margin={{ left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef0f3" />
                <XAxis dataKey="code" tick={{ fontSize: 12, fill: "#8a929c" }} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "#8a929c" }} axisLine={false} tickLine={false} />
                <Bar dataKey="avg" fill={brand} radius={[6, 6, 0, 0]} maxBarSize={54} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <NoData />
          )}
        </div>

        <div className="card p-5">
          <div className="font-semibold text-[var(--color-ink)]">Average score trend</div>
          <div className="mono-label mt-0.5 mb-4">
            {d.trend.length ? `Across the last ${d.trend.length} finished assessments` : "Finished assessments"}
          </div>
          {d.trend.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={d.trend} margin={{ left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef0f3" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#8a929c" }} axisLine={false} tickLine={false} />
                <YAxis domain={[40, 90]} tick={{ fontSize: 11, fill: "#8a929c" }} axisLine={false} tickLine={false} />
                <Line type="monotone" dataKey="avg" stroke={brand} strokeWidth={2.5} dot={{ r: 3, fill: brand }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <NoData />
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <div className="card p-5">
          <div className="font-semibold text-[var(--color-ink)] mb-4">Top students · overall</div>
          {d.topStudents.length ? (
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
          ) : (
            <NoData />
          )}
        </div>

        <div className="card p-5">
          <div className="font-semibold text-[var(--color-ink)] mb-4">Class toppers</div>
          {d.classToppers.length ? (
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
          ) : (
            <NoData />
          )}
        </div>
      </div>
    </div>
  );
}

function NoData() {
  return (
    <div className="flex items-center justify-center h-[180px] text-sm text-[var(--color-muted)] text-center px-4">
      No data right now — it will appear once an assessment is finished.
    </div>
  );
}
