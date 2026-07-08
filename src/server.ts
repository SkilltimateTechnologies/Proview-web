import app from "./api";
import { sweepPendingGrading, startAutoSubmitSweep } from "./api/lib/grade-queue";

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
