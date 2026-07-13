// Section-wise assessment report PDF: branded header, summary stats, present/absent
// donut, grade-band bars, 0–100 distribution, ties-aware top-3 podium, and the full
// ranked roster. Exported as a downloadable Blob via generateSectionReport().
import { Document, Page, View, Text, Image, StyleSheet, pdf } from "@react-pdf/renderer";
import {
  C,
  type Brand,
  type ReportRow,
  topPerformers,
  rankAll,
  scoreBuckets,
  bandCounts,
  summarize,
  fmtDate,
} from "./theme";
import { BarChart, Donut, BandBars } from "./charts";

const s = StyleSheet.create({
  page: { paddingTop: 28, paddingBottom: 44, paddingHorizontal: 34, fontFamily: "Helvetica", color: C.ink },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  logo: { height: 26, objectFit: "contain" },
  college: { fontSize: 10, color: C.ink2, fontFamily: "Helvetica-Bold", maxWidth: 260, textAlign: "right" },
  accentBar: { height: 3, borderRadius: 2, marginTop: 8, marginBottom: 14 },
  title: { fontSize: 18, fontFamily: "Helvetica-Bold", color: C.ink },
  sub: { fontSize: 9, color: C.ink2, marginTop: 3 },
  metaRow: { flexDirection: "row", marginTop: 6, gap: 14 },
  metaItem: { fontSize: 8, color: C.muted },
  metaVal: { color: C.ink2, fontFamily: "Helvetica-Bold" },

  sectionLabel: { fontSize: 8, letterSpacing: 1, color: C.muted, fontFamily: "Helvetica-Bold", textTransform: "uppercase", marginBottom: 8 },

  statsRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  statCard: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 8, backgroundColor: C.white },
  statNum: { fontSize: 17, fontFamily: "Helvetica-Bold", color: C.ink },
  statLabel: { fontSize: 6.5, letterSpacing: 0.6, color: C.muted, textTransform: "uppercase", marginTop: 3 },

  panelsRow: { flexDirection: "row", gap: 12, marginTop: 18 },
  panel: { borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 12, backgroundColor: C.white },
  panelTitle: { fontSize: 9, fontFamily: "Helvetica-Bold", color: C.ink, marginBottom: 8 },

  legendRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 },
  legendDot: { width: 7, height: 7, borderRadius: 2 },
  legendTxt: { fontSize: 7.5, color: C.ink2 },

  podiumRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  podCard: { flex: 1, borderRadius: 8, padding: 9, borderWidth: 1 },
  podRank: { fontSize: 8, fontFamily: "Helvetica-Bold" },
  podName: { fontSize: 9, fontFamily: "Helvetica-Bold", color: C.ink, marginTop: 3 },
  podRoll: { fontSize: 7, color: C.muted, marginTop: 1 },
  podScore: { fontSize: 14, fontFamily: "Helvetica-Bold", marginTop: 4 },

  tableHead: { flexDirection: "row", backgroundColor: C.soft, borderTopLeftRadius: 6, borderTopRightRadius: 6, paddingVertical: 6, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  th: { fontSize: 7, letterSpacing: 0.5, color: C.muted, fontFamily: "Helvetica-Bold", textTransform: "uppercase" },
  tr: { flexDirection: "row", paddingVertical: 5.5, paddingHorizontal: 8, borderBottomWidth: 0.5, borderBottomColor: C.line },
  td: { fontSize: 8.5, color: C.ink },
  cRank: { width: 34 },
  cName: { flex: 1 },
  cRoll: { width: 92 },
  cStatus: { width: 70 },
  cScore: { width: 46, textAlign: "right" },

  footer: { position: "absolute", bottom: 18, left: 34, right: 34, flexDirection: "row", justifyContent: "space-between", borderTopWidth: 0.5, borderTopColor: C.line, paddingTop: 6 },
  footTxt: { fontSize: 7, color: C.muted },
});

function Stat({ num, label, color }: { num: string; label: string; color?: string }) {
  return (
    <View style={s.statCard}>
      <Text style={[s.statNum, color ? { color } : {}]}>{num}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

const PODIUM = [
  { border: C.gold, tint: "#FBF6E4", label: "1st place", chip: C.gold },
  { border: C.silver, tint: "#F2F4F7", label: "2nd place", chip: C.silver },
  { border: C.bronze, tint: "#F7EFE6", label: "3rd place", chip: C.bronze },
];

export type SectionReportData = {
  brand: Brand;
  examTitle: string;
  section: string; // "All sections" when unfiltered
  rows: ReportRow[];
};

export function SectionReportDoc({ brand, examTitle, section, rows }: SectionReportData) {
  const stats = summarize(rows);
  const buckets = scoreBuckets(rows);
  const bands = bandCounts(rows);
  const top = topPerformers(rows);
  const ranks = rankAll(rows);
  const accent = brand.accent || "#1E3A5F";

  // group podium students by rank so ties render together
  const byRank = [1, 2, 3].map((rk) => top.filter((t) => t.rank === rk));

  const ordered = [...rows].sort((a, b) => {
    if (a.absent && !b.absent) return 1;
    if (!a.absent && b.absent) return -1;
    return (b.score ?? -1) - (a.score ?? -1);
  });

  return (
    <Document title={`${examTitle} — ${section} report`}>
      <Page size="A4" style={s.page}>
        {/* Header */}
        <View style={s.headerRow}>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={brand.logoUrl} style={s.logo} />
          <Text style={s.college}>{brand.collegeName}</Text>
        </View>
        <View style={[s.accentBar, { backgroundColor: accent }]} />

        <Text style={s.title}>{examTitle}</Text>
        <Text style={s.sub}>Section-wise assessment report</Text>
        <View style={s.metaRow}>
          <Text style={s.metaItem}>Section: <Text style={s.metaVal}>{section}</Text></Text>
          <Text style={s.metaItem}>Generated: <Text style={s.metaVal}>{fmtDate(Date.now())}</Text></Text>
        </View>

        {/* Summary stats */}
        <View style={s.statsRow}>
          <Stat num={String(stats.total)} label="Students" />
          <Stat num={String(stats.present)} label="Appeared" color={C.green} />
          <Stat num={String(stats.absent)} label="Absent" color={C.red} />
          <Stat num={stats.highest != null ? String(stats.highest) : "\u2014"} label="Highest" />
          <Stat num={stats.lowest != null ? String(stats.lowest) : "\u2014"} label="Lowest" />
          <Stat num={stats.average != null ? String(stats.average) : "\u2014"} label="Average" />
          <Stat num={stats.passRate != null ? `${stats.passRate}%` : "\u2014"} label="Pass (50%+)" color={accent} />
        </View>

        {/* Donut + band bars */}
        <View style={s.panelsRow}>
          <View style={[s.panel, { width: 168, alignItems: "center" }]}>
            <Text style={s.panelTitle}>Attendance</Text>
            <Donut present={stats.present} absent={stats.absent} size={104} />
            <View style={{ flexDirection: "row", gap: 14, marginTop: 8 }}>
              <View style={s.legendRow}>
                <View style={[s.legendDot, { backgroundColor: C.green }]} />
                <Text style={s.legendTxt}>Appeared ({stats.present})</Text>
              </View>
              <View style={s.legendRow}>
                <View style={[s.legendDot, { backgroundColor: C.red }]} />
                <Text style={s.legendTxt}>Absent ({stats.absent})</Text>
              </View>
            </View>
          </View>
          <View style={[s.panel, { flex: 1 }]}>
            <Text style={s.panelTitle}>Grade bands (of appeared)</Text>
            <BandBars data={bands} width={320} height={112} />
          </View>
        </View>

        {/* Distribution */}
        <View style={[s.panel, { marginTop: 12 }]}>
          <Text style={s.panelTitle}>Score distribution (0–100)</Text>
          <BarChart data={buckets} width={510} height={120} color={accent} />
        </View>

        {/* Podium */}
        <View style={{ marginTop: 18 }} wrap={false}>
          <Text style={s.sectionLabel}>Top performers</Text>
          <View style={s.podiumRow}>
            {byRank.map((group, i) => {
              const p = PODIUM[i];
              return (
                <View key={i} style={[s.podCard, { borderColor: p.border, backgroundColor: p.tint }]}>
                  <Text style={[s.podRank, { color: p.chip }]}>{p.label}</Text>
                  {group.length === 0 ? (
                    <Text style={[s.podName, { color: C.muted }]}>{"\u2014"}</Text>
                  ) : (
                    group.map((g) => (
                      <View key={g.attemptId} style={{ marginTop: 2 }}>
                        <Text style={s.podName}>{g.name}</Text>
                        <Text style={s.podRoll}>{g.rollNo}{g.section ? ` · ${g.section}` : ""}</Text>
                        <Text style={[s.podScore, { color: p.chip }]}>{g.score}<Text style={{ fontSize: 8, color: C.muted }}>/100</Text></Text>
                      </View>
                    ))
                  )}
                </View>
              );
            })}
          </View>
        </View>

        {/* Roster table */}
        <View style={{ marginTop: 18 }}>
          <Text style={s.sectionLabel}>All students ({ordered.length})</Text>
          <View style={s.tableHead}>
            <Text style={[s.th, s.cRank]}>Rank</Text>
            <Text style={[s.th, s.cName]}>Student</Text>
            <Text style={[s.th, s.cRoll]}>Roll No</Text>
            <Text style={[s.th, s.cStatus]}>Status</Text>
            <Text style={[s.th, s.cScore]}>Score</Text>
          </View>
          {ordered.map((r, i) => {
            const rank = ranks.get(r.attemptId);
            const statusTxt = r.absent
              ? "Absent"
              : r.disconnected
              ? `Disconnected ${r.answeredCount ?? 0}`
              : r.status === "graded"
              ? "Submitted"
              : "Grading";
            const statusColor = r.absent ? C.red : r.disconnected ? C.amber : r.status === "graded" ? C.green : C.amber;
            return (
              <View key={r.attemptId + i} style={[s.tr, i % 2 ? { backgroundColor: C.soft } : {}]} wrap={false}>
                <Text style={[s.td, s.cRank, { color: C.muted }]}>{r.absent || rank == null ? "\u2014" : `#${rank}`}</Text>
                <Text style={[s.td, s.cName]}>{r.name}</Text>
                <Text style={[s.td, s.cRoll, { color: C.ink2 }]}>{r.rollNo || "\u2014"}</Text>
                <Text style={[s.td, s.cStatus, { color: statusColor }]}>{statusTxt}</Text>
                <Text style={[s.td, s.cScore, { fontFamily: "Helvetica-Bold" }]}>{r.absent ? "A" : r.score != null ? r.score : "\u2014"}</Text>
              </View>
            );
          })}
        </View>

        {/* Footer */}
        <View style={s.footer} fixed>
          <Text style={s.footTxt}>{brand.collegeName} · Proview by Skilltimate</Text>
          <Text style={s.footTxt} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export async function generateSectionReport(data: SectionReportData): Promise<Blob> {
  return await pdf(<SectionReportDoc {...data} />).toBlob();
}
