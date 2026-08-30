import { readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import app from "./api";
import { startAutoSubmitSweep, startGradeQueue } from "./api/lib/grade-queue";
import { ensureDatabaseInvariants, ensureRequiredColumns } from "./api/database/invariants";
import {
	CompressedAssets,
	buildManifest,
	planResponse,
	routeFor,
	type Encoding,
	type ManifestInput,
	type StaticEntry,
} from "./api/lib/static-assets";

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

/* ---------------------------------------------------------------------------
 * Static serving.
 *
 * At ~1000 concurrent students the exam pages stopped loading, and the measured
 * cause was here rather than in the database: prod served `/assets/index-*.js`
 * as 1.6 MB of *uncompressed* text with no `cache-control`, no `etag` and no
 * `last-modified` (verified with `curl -sSI -H 'Accept-Encoding: gzip, br'`), so
 * every student re-downloaded the whole bundle on every page load, refresh and
 * SEB restart — roughly 1.5 GB of egress through a single Bun process with no
 * CDN in front of it. The old handler also did an `await file.exists()` stat on
 * every request. Now: one directory walk at boot, brotli/gzip variants held in
 * memory, immutable caching on vite's content-hashed filenames and ETag/304 on
 * everything else. Policy lives in `api/lib/static-assets.ts` (unit-tested);
 * this file only does the I/O.
 * ------------------------------------------------------------------------- */

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

// Quality 9 rather than 11: measured on our real bundle, q9 is 474 KB in 158 ms
// while q11 is 433 KB in 3.8 s. The extra 41 KB is not worth ~24x the CPU on a
// single-core container that may still be answering requests.
const BROTLI_QUALITY = 9;

async function collectStaticFiles(dir: string, prefix = ""): Promise<ManifestInput[]> {
	const collected: ManifestInput[] = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		// No dist directory yet (fresh checkout without a build). The handler
		// below reports that clearly instead of crashing the server at boot.
		return collected;
	}
	for (const entry of entries) {
		const absolute = `${dir}/${entry.name}`;
		const route = `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			collected.push(...(await collectStaticFiles(absolute, route)));
			continue;
		}
		if (!entry.isFile()) continue;
		const stats = await stat(absolute);
		collected.push({ route, path: absolute, size: stats.size, mtimeMs: stats.mtimeMs });
	}
	return collected;
}

const staticManifest = buildManifest(await collectStaticFiles(distDir));

const compressedAssets = new CompressedAssets(
	async (bytes: Uint8Array, encoding: Encoding) => {
		if (encoding === "br") {
			return new Uint8Array(
				await brotliCompressAsync(bytes, {
					params: {
						[zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
						[zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
					},
				}),
			);
		}
		return new Uint8Array(await gzipAsync(bytes, { level: 9 }));
	},
	(path: string) => Bun.file(path).bytes(),
);

// Routes we have already looked for on disk and not found. Without this a bot
// probing paths would put a filesystem stat back on the request path.
const knownMissing = new Set<string>();

async function registerLateFile(route: string): Promise<StaticEntry | undefined> {
	if (knownMissing.has(route)) return undefined;
	const absolute = `${distDir}${route}`;
	try {
		const stats = await stat(absolute);
		if (!stats.isFile()) throw new Error("not a file");
		const [entry] = buildManifest([
			{ route, path: absolute, size: stats.size, mtimeMs: stats.mtimeMs },
		]).values();
		if (entry) staticManifest.set(route, entry);
		return entry;
	} catch {
		if (knownMissing.size > 5000) knownMissing.clear();
		knownMissing.add(route);
		return undefined;
	}
}

function staticResponse(route: string, entry: StaticEntry, request: Request): Response {
	const available = compressedAssets.available(route);
	const plan = planResponse(
		entry,
		{
			method: request.method,
			ifNoneMatch: request.headers.get("if-none-match"),
			acceptEncoding: request.headers.get("accept-encoding"),
		},
		available,
		(encoding) => compressedAssets.sizeOf(route, encoding),
	);

	// Compression is never awaited by a request: schedule anything still missing
	// and serve what we have right now.
	if (entry.compressible && available.length < 2) {
		compressedAssets.warmInBackground(route, entry);
	}

	if (!plan.body) {
		return new Response(null, { status: plan.status, headers: plan.headers });
	}
	const variant = plan.encoding ? compressedAssets.get(route, plan.encoding) : undefined;
	// A Uint8Array is a valid body at runtime; the cast is only needed because the
	// DOM `BodyInit` union in our TS lib does not include ArrayBufferView.
	const body = (variant as unknown as BodyInit | undefined) ?? Bun.file(entry.path);
	return new Response(body, { status: plan.status, headers: plan.headers });
}

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

    const route = routeFor(url.pathname);
    const hit = staticManifest.get(route);
    if (hit) return staticResponse(route, hit, request);

    // A path that looks like a file but was not in the boot manifest: it can
    // exist after a local rebuild without a restart, so check the disk once and
    // remember the answer either way.
    if (route !== "/" && /\.[A-Za-z0-9]+$/.test(route)) {
      const late = await registerLateFile(route);
      if (late) return staticResponse(route, late, request);
    }

    // Everything else is a client-side route: hand back the SPA shell.
    const shell = staticManifest.get("/index.html");
    if (shell) return staticResponse("/index.html", shell, request);

    return new Response("Build output not found. Run `bun run build` first.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
});

console.log(`Web server listening on http://localhost:${server.port}`);

// Pre-compress the bundle off the boot path so the very first student of the day
// already gets brotli instead of 1.6 MB of plain JavaScript. Sequential on
// purpose: zlib runs on the thread pool and this must never starve request
// handling. Largest first, because that is the file every student downloads.
void (async () => {
  const compressible = [...staticManifest.entries()]
    .filter(([, entry]) => entry.compressible)
    .sort(([, a], [, b]) => b.size - a.size);
  const started = Date.now();
  for (const [route, entry] of compressible) {
    await compressedAssets.warm(route, entry);
  }
  console.log(
    `[static] ${compressible.length} asset(s) pre-compressed in ${Date.now() - started}ms, ` +
      `${(compressedAssets.heldBytes / 1024).toFixed(0)}KB held`,
  );
})();

// Assert the database's uniqueness guarantees before doing any background work.
// These indexes are what actually make duplicate attempts/answers impossible —
// the app-level upserts need them to exist to have anything to conflict on. There
// is no migrate step in the deploy path, so this is the only thing standing
// between a freshly provisioned / restored database and the return of the
// duplicate-row score corruption. Awaited so the grading sweeps below run against
// a database we have already verified; never throws.
await ensureDatabaseInvariants();

// What this process is allowed to do in the background.
//
// Defaults to "all" so today's single-process deployment behaves exactly as it
// did before the durable queue existed: this process serves requests AND grades.
// The point of the flag is that going to 2-3 Railway replicas later is a config
// change, not a code change — set ROLE=web on the replicas behind the load
// balancer and ROLE=worker on one background process, and the same image stops
// running three copies of every sweep. Unknown values fall back to "all": a typo
// in a Railway variable must never silently stop grading.
const role = (process.env.ROLE ?? "all").toLowerCase();
const runsBackgroundWork = role !== "web";
if (role !== "all") console.log(`[boot] ROLE=${role} (background work: ${runsBackgroundWork ? "on" : "off"})`);

if (runsBackgroundWork) {
  // Bring up the durable grading queue: probe `grade_jobs`, adopt any attempts
  // left `submitted` by a restart, then start the worker and the slow reconcile
  // sweep. Falls back to the in-memory schedule if the table is unreachable, so
  // grading degrades rather than stops. Not awaited — boot must not wait on it.
  void startGradeQueue();

  // Recurring server-side auto-submit: force-submit + grade any expired
  // `in_progress` attempts (student closed the browser / lost connection at the
  // cutoff) so they never stay stuck in-progress. Runs every 60s.
  startAutoSubmitSweep(60_000);
}
