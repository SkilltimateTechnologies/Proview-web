/* Static-asset serving policy for the SPA bundle.
 *
 * Why this exists: at ~1000 concurrent students the exam pages stopped loading.
 * The measured cause was not the database — it was the static handler. Railway's
 * edge does not compress for us, so `/assets/index-*.js` went out as 1.6 MB of
 * plain text with NO `cache-control`, NO `etag` and NO `last-modified`. Every
 * student re-downloaded the whole bundle on every page load, every refresh and
 * every SEB restart (~1.5 GB of egress through one Bun process, no CDN), and the
 * offline service worker's stale-while-revalidate re-fetched all of it too
 * because nothing let the HTTP cache answer instead.
 *
 * Everything here is deliberately free of filesystem and zlib calls so it can be
 * unit-tested directly: `src/server.ts` owns the I/O, this module owns the
 * decisions (content type, cache lifetime, ETag, encoding negotiation, 304).
 */

export type StaticEntry = {
	/** Absolute path on disk. */
	path: string;
	/** Identity (uncompressed) byte length. */
	size: number;
	/** Strong ETag, quoted, derived from size + mtime. */
	etag: string;
	contentType: string;
	cacheControl: string;
	/** Whether it is worth spending CPU compressing this response. */
	compressible: boolean;
};

export type ManifestInput = {
	/** URL path, always leading-slash, e.g. `/assets/index-abc123.js`. */
	route: string;
	path: string;
	size: number;
	mtimeMs: number;
};

export type Encoding = "br" | "gzip";

const CONTENT_TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	json: "application/json; charset=utf-8",
	map: "application/json; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	xml: "application/xml; charset=utf-8",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	otf: "font/otf",
	eot: "application/vnd.ms-fontobject",
	pdf: "application/pdf",
	mp3: "audio/mpeg",
	mp4: "video/mp4",
	webm: "video/webm",
	wasm: "application/wasm",
	zip: "application/zip",
	csv: "text/csv; charset=utf-8",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** One year. Only safe on content-hashed filenames. */
export const IMMUTABLE_MAX_AGE = 31_536_000;
/** Unhashed files under `public/` (favicon, og-image, exam-lab.webp…). */
export const PUBLIC_MAX_AGE = 3600;
/** Anything bigger than this is not worth holding compressed in memory. */
export const MAX_COMPRESS_BYTES = 8 * 1024 * 1024;
/** Below this, compression saves less than the framing costs. */
export const MIN_COMPRESS_BYTES = 512;

export function extensionOf(route: string): string {
	const last = route.slice(route.lastIndexOf("/") + 1);
	const dot = last.lastIndexOf(".");
	if (dot <= 0) return "";
	return last.slice(dot + 1).toLowerCase();
}

export function contentTypeFor(route: string): string {
	return CONTENT_TYPES[extensionOf(route)] ?? "application/octet-stream";
}

/** Vite emits `name-HASH.ext`; only those may be served as immutable. */
export function isHashedAsset(route: string): boolean {
	if (!route.startsWith("/assets/")) return false;
	const name = route.slice(route.lastIndexOf("/") + 1);
	return /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(name);
}

export function cacheControlFor(route: string): string {
	// The service worker and the HTML shell decide which bundle a student runs.
	// If either one is allowed to go stale, a student can end up executing a
	// bundle that no longer matches the deployed API. Always revalidate them.
	if (route === "/index.html" || route === "/" || route === "/sw.js") {
		return "no-cache";
	}
	if (isHashedAsset(route)) return `public, max-age=${IMMUTABLE_MAX_AGE}, immutable`;
	return `public, max-age=${PUBLIC_MAX_AGE}`;
}

export function isCompressible(contentType: string, size: number): boolean {
	if (size < MIN_COMPRESS_BYTES || size > MAX_COMPRESS_BYTES) return false;
	const type = contentType.split(";")[0]!.trim();
	if (type.startsWith("text/")) return true;
	if (type === "image/svg+xml") return true;
	if (type === "application/wasm") return true;
	if (type === "application/json") return true;
	if (type === "application/xml") return true;
	if (type === "application/vnd.ms-fontobject") return true;
	// Already-compressed containers (png/jpeg/webp/woff2/zip/pdf/mp4) gain
	// nothing and would burn CPU per deploy.
	return false;
}

export function etagFor(size: number, mtimeMs: number): string {
	const stamp = Math.floor(mtimeMs).toString(36);
	return `"${size.toString(36)}-${stamp}"`;
}

export function buildManifest(files: ManifestInput[]): Map<string, StaticEntry> {
	const manifest = new Map<string, StaticEntry>();
	for (const file of files) {
		const contentType = contentTypeFor(file.route);
		manifest.set(file.route, {
			path: file.path,
			size: file.size,
			etag: etagFor(file.size, file.mtimeMs),
			contentType,
			cacheControl: cacheControlFor(file.route),
			compressible: isCompressible(contentType, file.size),
		});
	}
	return manifest;
}

/**
 * Map a request pathname to a manifest key. Traversal-safe: `..` segments are
 * dropped rather than resolved, and the result is always a single leading slash.
 */
export function routeFor(pathname: string): string {
	let decoded = pathname;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		// A malformed %-escape is not a valid asset path; fall through with the raw
		// value so it simply misses the manifest instead of throwing a 500.
	}
	const segments = decoded
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
	return `/${segments.join("/")}`;
}

/** Parse an `Accept-Encoding` header into token -> quality. */
export function parseAcceptEncoding(header: string | null | undefined): Map<string, number> {
	const parsed = new Map<string, number>();
	if (!header) return parsed;
	for (const part of header.split(",")) {
		const [rawToken, ...params] = part.split(";");
		const token = rawToken?.trim().toLowerCase();
		if (!token) continue;
		let quality = 1;
		for (const param of params) {
			const [key, value] = param.split("=");
			if (key?.trim().toLowerCase() === "q") {
				const parsedQuality = Number.parseFloat(value ?? "");
				quality = Number.isFinite(parsedQuality) ? parsedQuality : 0;
			}
		}
		parsed.set(token, quality);
	}
	return parsed;
}

/**
 * Pick the best encoding the client accepts out of the ones we actually hold.
 * Brotli first (measured ~20% smaller than gzip on our bundle), then gzip.
 */
export function negotiateEncoding(
	acceptEncoding: string | null | undefined,
	available: readonly Encoding[],
): Encoding | null {
	if (available.length === 0) return null;
	const accepted = parseAcceptEncoding(acceptEncoding);
	if (accepted.size === 0) return null;
	const wildcard = accepted.get("*");
	const qualityOf = (token: Encoding) => accepted.get(token) ?? wildcard ?? 0;
	let best: Encoding | null = null;
	let bestQuality = 0;
	for (const candidate of ["br", "gzip"] as const) {
		if (!available.includes(candidate)) continue;
		const quality = qualityOf(candidate);
		if (quality > bestQuality) {
			best = candidate;
			bestQuality = quality;
		}
	}
	return best;
}

/** Does `If-None-Match` cover this entity? Handles `*` and comma-separated lists. */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
	if (!ifNoneMatch) return false;
	const header = ifNoneMatch.trim();
	if (header === "*") return true;
	for (const candidate of header.split(",")) {
		const token = candidate.trim();
		if (!token) continue;
		// A weak validator still identifies the same bytes for our purposes.
		const normalized = token.startsWith("W/") ? token.slice(2) : token;
		if (normalized === etag) return true;
	}
	return false;
}

export type ServePlan = {
	status: 200 | 304;
	headers: Record<string, string>;
	/** null = send the identity bytes; otherwise the pre-compressed variant. */
	encoding: Encoding | null;
	/** 304 and HEAD must not carry a body. */
	body: boolean;
};

export type ServeRequest = {
	method: string;
	ifNoneMatch?: string | null;
	acceptEncoding?: string | null;
};

/**
 * Decide the full response shape for one static hit. `available` lists the
 * compressed variants already cached in memory for this entry, and
 * `encodedSize` gives their byte lengths so `Content-Length` stays exact.
 */
export function planResponse(
	entry: StaticEntry,
	request: ServeRequest,
	available: readonly Encoding[] = [],
	encodedSize?: (encoding: Encoding) => number | undefined,
): ServePlan {
	const headers: Record<string, string> = {
		"Content-Type": entry.contentType,
		"Cache-Control": entry.cacheControl,
		ETag: entry.etag,
	};
	if (entry.compressible) headers.Vary = "Accept-Encoding";

	if (etagMatches(request.ifNoneMatch, entry.etag)) {
		return { status: 304, headers, encoding: null, body: false };
	}

	const encoding = entry.compressible
		? negotiateEncoding(request.acceptEncoding, available)
		: null;
	const length = encoding ? encodedSize?.(encoding) : entry.size;
	if (encoding) headers["Content-Encoding"] = encoding;
	if (typeof length === "number") headers["Content-Length"] = String(length);

	const method = request.method.toUpperCase();
	return { status: 200, headers, encoding, body: method !== "HEAD" };
}

/**
 * In-memory store of compressed variants, filled lazily off the request path.
 *
 * Compression is never awaited by a request: the first request for an asset
 * schedules the work and is served identity bytes, and every later request gets
 * the cached variant. That keeps a 2 MB brotli pass from blocking the event loop
 * while 1000 students are mid-exam. Bounded so a large `public/` directory can
 * never eat the container's memory.
 */
export class CompressedAssets {
	private readonly variants = new Map<string, Uint8Array>();
	private readonly pending = new Set<string>();
	private bytesHeld = 0;

	constructor(
		private readonly compress: (bytes: Uint8Array, encoding: Encoding) => Promise<Uint8Array>,
		private readonly read: (path: string) => Promise<Uint8Array>,
		private readonly budgetBytes = 64 * 1024 * 1024,
	) {}

	private key(route: string, encoding: Encoding) {
		return `${encoding} ${route}`;
	}

	get(route: string, encoding: Encoding): Uint8Array | undefined {
		return this.variants.get(this.key(route, encoding));
	}

	available(route: string): Encoding[] {
		const ready: Encoding[] = [];
		for (const encoding of ["br", "gzip"] as const) {
			if (this.variants.has(this.key(route, encoding))) ready.push(encoding);
		}
		return ready;
	}

	sizeOf(route: string, encoding: Encoding): number | undefined {
		return this.get(route, encoding)?.byteLength;
	}

	get heldBytes(): number {
		return this.bytesHeld;
	}

	/** Compress both variants for one entry. Safe to call repeatedly. */
	async warm(route: string, entry: StaticEntry): Promise<void> {
		if (!entry.compressible) return;
		if (this.pending.has(route)) return;
		const missing = (["br", "gzip"] as const).filter(
			(encoding) => !this.variants.has(this.key(route, encoding)),
		);
		if (missing.length === 0) return;
		this.pending.add(route);
		try {
			const identity = await this.read(entry.path);
			for (const encoding of missing) {
				if (this.bytesHeld >= this.budgetBytes) break;
				const compressed = await this.compress(identity, encoding);
				// A variant that is not smaller than the original is pointless.
				if (compressed.byteLength >= identity.byteLength) continue;
				// Never overshoot the budget: the container has a hard memory
				// ceiling and an OOM kill mid-exam is far worse than a larger
				// response.
				if (this.bytesHeld + compressed.byteLength > this.budgetBytes) break;
				this.variants.set(this.key(route, encoding), compressed);
				this.bytesHeld += compressed.byteLength;
			}
		} catch (error) {
			// Compression is an optimisation, never a correctness requirement: on
			// any failure we keep serving the identity bytes.
			console.error(`[static] could not compress ${route}`, error);
		} finally {
			this.pending.delete(route);
		}
	}

	/** Fire-and-forget variant of `warm` for use on the request path. */
	warmInBackground(route: string, entry: StaticEntry): void {
		void this.warm(route, entry);
	}
}
