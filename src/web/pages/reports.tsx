import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ChevronRight, Search, Users, CheckCircle2, Clock, UserX } from "lucide-react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { PageHeader } from "../components/shell";
import { Loader, EmptyState, Pill, StatCard, usePagination, Pager } from "../components/ui";

const STATUS_COLOR: Record<string, string> = {
  finished: "#2e7d5b",
  live: "#c0453b",
  scheduled: "#b7791f",
  draft: "#8a929c",
  ended: "#5b6472",
};

function fmtConducted(v: number | string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v as any);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

type Report = {
  id: string;
  title: string;
  status: string;
  attempts: number;
  assigned: number;
  finished: number;
  inProgress: number;
  absent: number;
  wrote: number;
  graded: number;
  passed: number;
  failed: number;
  avg: number | string;
  startAt?: number | string | null;
  createdAt?: number | string | null;
};

export default function Reports() {
  const { me } = useSession();
  const [, navigate] = useLocation();
  const isTpo = me?.profile.role === "tpo";
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");

  const q = useQuery({
    queryKey: ["reports"],
    queryFn: async () => {
      const res = await api.reports.$get();
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
  });

  const all = (q.data?.exams ?? []) as Report[];

  const rows = useMemo(() => {
    let list = all;
    if (search.trim()) list = list.filter((e) => e.title.toLowerCase().includes(search.trim().toLowerCase()));
    if (status !== "all") list = list.filter((e) => e.status === status);
    return list;
  }, [all, search, status]);

  const totals = useMemo(() => {
    return all.reduce(
      (acc, e) => {
        acc.assigned += e.assigned;
        acc.finished += e.finished;
        acc.inProgress += e.inProgress;
        acc.absent += e.absent;
        acc.passed += e.passed;
        acc.failed += e.failed;
        return acc;
      },
      { assigned: 0, finished: 0, inProgress: 0, absent: 0, passed: 0, failed: 0 },
    );
  }, [all]);

  const pg = usePagination(rows);

  return (
    <div className="rise">
      <PageHeader eyebrow="Results" title="Reports" action={isTpo ? <Pill label="FINISHED ONLY" color="#2e7d5b" /> : undefined} />

      {q.isLoading ? (
        <Loader />
      ) : !all.length ? (
        <EmptyState title="No reports yet" hint={isTpo ? "Reports unlock once an assessment finishes." : "Finish an assessment to generate reports."} />
      ) : (
        <>
          {/* Summary stats across all conducted assessments */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            <StatCard label="Assigned" value={totals.assigned} icon={<Users size={18} />} />
            <StatCard label="Finished" value={totals.finished} icon={<CheckCircle2 size={18} />} tone="#2e7d5b" />
            <StatCard label="Passed" value={totals.passed} icon={<CheckCircle2 size={18} />} tone="#2e7d5b" />
            <StatCard label="Failed" value={totals.failed} icon={<UserX size={18} />} tone="#c0453b" />
            <StatCard label="In Progress" value={totals.inProgress} icon={<Clock size={18} />} tone="#b7791f" />
            <StatCard label="Absent" value={totals.absent} icon={<UserX size={18} />} tone="#c0453b" />
          </div>

          <div className="card p-3 mb-4 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)]" />
              <input
                className="input pl-9"
                placeholder="Search assessments…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {!isTpo && (
              <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="all">All statuses</option>
                <option value="finished">Finished</option>
                <option value="live">Live</option>
              </select>
            )}
          </div>

          {!rows.length ? (
            <EmptyState title="No matching reports" hint="Try adjusting your filters." />
          ) : (
            <div className="card overflow-hidden">
              <div className="table-scroll">
                <table className="data-table w-full">
                  <thead>
                    <tr>
                      <th className="text-left">Assessment</th>
                      <th className="text-left">Date Conducted</th>
                      <th className="text-center">Assigned</th>
                      <th className="text-center">Finished</th>
                      <th className="text-center">Passed</th>
                      <th className="text-center">Failed</th>
                      <th className="text-center">In Progress</th>
                      <th className="text-center">Absent</th>
                      <th className="text-left">Status</th>
                      <th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pg.pageItems.map((e) => {
                      const donePct = e.assigned ? Math.round((e.finished / e.assigned) * 100) : 0;
                      return (
                        <tr
                          key={e.id}
                          className="cursor-pointer hover:bg-[var(--color-brand-soft)] transition"
                          onClick={() => navigate(`/reports/${e.id}`)}
                        >
                          <td>
                            <div className="font-medium text-[var(--color-ink)]">{e.title}</div>
                            <div className="mono-label mt-0.5">{donePct}% completed</div>
                          </td>
                          <td className="text-left text-[var(--color-ink)]">{fmtConducted(e.startAt ?? e.createdAt)}</td>
                          <td className="text-center font-medium text-[var(--color-ink)]">{e.assigned}</td>
                          <td className="text-center">
                            <span className="font-semibold" style={{ color: "#2e7d5b" }}>{e.finished}</span>
                          </td>
                          <td className="text-center">
                            <span className="font-semibold" style={{ color: "#2e7d5b" }}>{e.passed}</span>
                            {e.graded ? <div className="mono-label mt-0.5">{Math.round((e.passed / e.graded) * 100)}%</div> : null}
                          </td>
                          <td className="text-center">
                            <span className="font-semibold" style={{ color: "#c0453b" }}>{e.failed}</span>
                            {e.graded ? <div className="mono-label mt-0.5">{Math.round((e.failed / e.graded) * 100)}%</div> : null}
                          </td>
                          <td className="text-center">
                            <span className="font-semibold" style={{ color: "#b7791f" }}>{e.inProgress}</span>
                          </td>
                          <td className="text-center">
                            <span className="font-semibold" style={{ color: "#c0453b" }}>{e.absent}</span>
                          </td>
                          <td>
                            <Pill label={e.status.toUpperCase()} color={STATUS_COLOR[e.status]} />
                          </td>
                          <td className="text-right pr-4">
                            <ChevronRight size={18} className="text-[var(--color-muted)] inline" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-3 border-t border-[var(--color-line)]">
                <Pager {...pg} onChange={pg.setPage} unit="reports" />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
