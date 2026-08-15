import app from "./api";
import { sweepPendingGrading, startAutoSubmitSweep } from "./api/lib/grade-queue";
import { ensureDatabaseInvariants, ensureRequiredColumns } from "./api/database/invariants";

// Never let a transient background failure (e.g. a brief Turso/libsql socket
// ECONNRESET during a background grading/auto-submit sweep) take down the whole
// exam server. Log and keep serving; the recurring sweeps retry on their next tick.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

// Additive schema repair has to happen BEFORE the first request is served, unlike
// the index checks below. Drizzle lists every column of a table in its SELECT, so a
// column that exists in `schema.ts` but not yet in the connected database makes
// every query on that table fail with `no such column` — students would see errors
// instead of their exam. Bounded and non-throwing: if the database is unreachable
// at boot we still come up (Railway's healthcheck must be able to answer) and the
// full check inside ensureDatabaseInvariants retries it a moment later.
await Promise.race([
  ensureRequiredColumns(),
  new Promise((resolve) => setTimeout(resolve, 15_000)).then(() =>
    console.error("[invariants] column check did not finish in 15s — serving anyway, will retry"),
  ),
]);

const port = Number(process.env.PORT ?? 3000);
const distDir = `${import.meta.dir}/../dist`;
const indexPath = `${distDir}/index.html`;

const server = Bun.serve({
  port,
  // Bun's default idleTimeout is 10s. The /student/run-code path can legitimately
  // run much longer under exam load (queue wait up to JUDGE0_MAX_WAIT_MS=30s +
  // Judge0 batch polling ~17.5s). If the socket idles past the limit Bun closes
  // it and the edge (Cloudflare/Railway) returns a raw 502 "Bad Gateway" with no
  // body — which is exactly what students saw as "Request failed (502)". 255s is
  // Bun's max and comfortably covers the worst-case synchronous run-code time.
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api")) {
      return app.fetch(request);
    }

    const filePath = getStaticFilePath(url.pathname);
    const file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file);
    }

    const index = Bun.file(indexPath);
    if (await index.exists()) {
      return new Response(index, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Build output not found. Run `bun run build` first.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
});

console.log(`Web server listening on http://localhost:${server.port}`);

// Assert the database's uniqueness guarantees before doing any background work.
// These indexes are what actually make duplicate attempts/answers impossible —
// the app-level upserts need them to exist to have anything to conflict on. There
// is no migrate step in the deploy path, so this is the only thing standing
// between a freshly provisioned / restored database and the return of the
// duplicate-row score corruption. Awaited so the grading sweeps below run against
// a database we have already verified; never throws.
await ensureDatabaseInvariants();

// Recover any subjective answers left ungraded (e.g. restart mid-grading or a
// prior AI rate-limit burst). Runs off the boot path, globally throttled.
void sweepPendingGrading();

// Recurring server-side auto-submit: force-submit + grade any expired
// `in_progress` attempts (student closed the browser / lost connection at the
// cutoff) so they never stay stuck in-progress. Runs every 60s.
startAutoSubmitSweep(60_000);

function getStaticFilePath(pathname: string) {
  const cleanPath = decodeURIComponent(pathname)
    .replace(/^\/+/, "")
    .replaceAll("..", "");

  return cleanPath ? `${distDir}/${cleanPath}` : indexPath;
}
