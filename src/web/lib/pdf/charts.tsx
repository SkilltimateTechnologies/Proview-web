// SVG chart primitives for the section report PDF. Built on @react-pdf/renderer's
// Svg elements so they rasterise crisply at any zoom in the exported file.
import { Svg, Rect, Path, Circle, Text as SvgText, G, Line } from "@react-pdf/renderer";
import { C } from "./theme";

/** Vertical bar chart — used for the 0–100 score distribution. */
export function BarChart({
  data,
  width,
  height,
  color = C.blue,
}: {
  data: { label: string; count: number }[];
  width: number;
  height: number;
  color?: string;
}) {
  const padL = 22;
  const padB = 26;
  const padT = 14;
  const plotW = width - padL - 8;
  const plotH = height - padB - padT;
  const max = Math.max(1, ...data.map((d) => d.count));
  const step = plotW / data.length;
  const barW = step * 0.62;
  // y gridlines at 0, mid, max
  const ticks = [0, Math.ceil(max / 2), max];
  return (
    <Svg width={width} height={height}>
      {ticks.map((t, i) => {
        const y = padT + plotH - (t / max) * plotH;
        return (
          <G key={i}>
            <Line x1={padL} y1={y} x2={width - 8} y2={y} strokeWidth={0.5} stroke={C.line} />
            <SvgText x={padL - 4} y={y + 3} style={{ fontSize: 6, fill: C.muted }} textAnchor="end">
              {String(t)}
            </SvgText>
          </G>
        );
      })}
      {data.map((d, i) => {
        const h = (d.count / max) * plotH;
        const x = padL + i * step + (step - barW) / 2;
        const y = padT + plotH - h;
        return (
          <G key={i}>
            <Rect x={x} y={y} width={barW} height={Math.max(h, d.count > 0 ? 1.5 : 0)} rx={1.5} fill={color} />
            {d.count > 0 && (
              <SvgText x={x + barW / 2} y={y - 2.5} style={{ fontSize: 6, fill: C.ink }} textAnchor="middle">
                {String(d.count)}
              </SvgText>
            )}
            <SvgText x={x + barW / 2} y={height - padB + 10} style={{ fontSize: 5.5, fill: C.muted }} textAnchor="middle">
              {d.label}
            </SvgText>
          </G>
        );
      })}
    </Svg>
  );
}

/** Present vs Absent donut. */
export function Donut({
  present,
  absent,
  size,
}: {
  present: number;
  absent: number;
  size: number;
}) {
  const total = present + absent;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 2;
  const presentFrac = total > 0 ? present / total : 0;

  const arc = (startFrac: number, endFrac: number) => {
    const a0 = -Math.PI / 2 + startFrac * 2 * Math.PI;
    const a1 = -Math.PI / 2 + endFrac * 2 * Math.PI;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const large = endFrac - startFrac > 0.5 ? 1 : 0;
    return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
  };

  return (
    <Svg width={size} height={size}>
      {total === 0 ? (
        <Circle cx={cx} cy={cy} r={r} fill={C.line} />
      ) : (
        <>
          {presentFrac > 0 && <Path d={arc(0, presentFrac)} fill={C.green} />}
          {presentFrac < 1 && <Path d={arc(presentFrac, 1)} fill={C.red} />}
        </>
      )}
      {/* donut hole */}
      <Circle cx={cx} cy={cy} r={r * 0.58} fill={C.white} />
      <SvgText x={cx} y={cy - 1} style={{ fontSize: 13, fill: C.ink }} textAnchor="middle">
        {total > 0 ? `${Math.round(presentFrac * 100)}%` : "\u2014"}
      </SvgText>
      <SvgText x={cx} y={cy + 9} style={{ fontSize: 6, fill: C.muted }} textAnchor="middle">
        present
      </SvgText>
    </Svg>
  );
}

/** Horizontal grade-band bars (>=90/80/70/60/50%). */
export function BandBars({
  data,
  width,
  height,
}: {
  data: { label: string; count: number; color: string }[];
  width: number;
  height: number;
}) {
  const rowH = height / data.length;
  const barH = rowH * 0.5;
  const labelW = 30;
  const max = Math.max(1, ...data.map((d) => d.count));
  const plotW = width - labelW - 18;
  return (
    <Svg width={width} height={height}>
      {data.map((d, i) => {
        const y = i * rowH + (rowH - barH) / 2;
        const w = (d.count / max) * plotW;
        return (
          <G key={i}>
            <SvgText x={0} y={y + barH / 2 + 3} style={{ fontSize: 7, fill: C.ink2 }}>
              {d.label}
            </SvgText>
            <Rect x={labelW} y={y} width={plotW} height={barH} rx={2} fill={C.soft} />
            <Rect x={labelW} y={y} width={Math.max(w, d.count > 0 ? 2 : 0)} height={barH} rx={2} fill={d.color} />
            <SvgText x={labelW + Math.max(w, 2) + 4} y={y + barH / 2 + 3} style={{ fontSize: 7, fill: C.ink }}>
              {String(d.count)}
            </SvgText>
          </G>
        );
      })}
    </Svg>
  );
}
