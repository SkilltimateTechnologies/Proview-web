import { describe, expect, test } from "bun:test";
import {
	CompressedAssets,
	IMMUTABLE_MAX_AGE,
	MAX_COMPRESS_BYTES,
	MIN_COMPRESS_BYTES,
	PUBLIC_MAX_AGE,
	buildManifest,
	cacheControlFor,
	contentTypeFor,
	etagFor,
	etagMatches,
	extensionOf,
	isCompressible,
	isHashedAsset,
	negotiateEncoding,
	parseAcceptEncoding,
	planResponse,
	routeFor,
	type Encoding,
	type StaticEntry,
} from "./static-assets";

const entry = (over: Partial<StaticEntry> = {}): StaticEntry => ({
	path: "/dist/assets/index-D-YyJTvy.js",
	size: 2_108_679,
	etag: '"abc-def"',
	contentType: "text/javascript; charset=utf-8",
	cacheControl: `public, max-age=${IMMUTABLE_MAX_AGE}, immutable`,
	compressible: true,
	...over,
});

describe("extensionOf", () => {
	test("reads the extension after the last dot of the last segment", () => {
		expect(extensionOf("/assets/index-D-YyJTvy.js")).toBe("js");
		expect(extensionOf("/assets/react-pdf.browser-CC5W9Rb6.js")).toBe("js");
		expect(extensionOf("/index.html")).toBe("html");
		expect(extensionOf("/favicon.ico")).toBe("ico");
	});

	test("uppercase extensions normalise", () => {
		expect(extensionOf("/logo.PNG")).toBe("png");
	});

	test("no extension yields empty string", () => {
		expect(extensionOf("/student/exam")).toBe("");
		expect(extensionOf("/")).toBe("");
	});

	test("a dotfile is not an extension", () => {
		expect(extensionOf("/.gitkeep")).toBe("");
	});

	test("a dot in a directory name is not the file's extension", () => {
		expect(extensionOf("/v1.2/bundle")).toBe("");
	});
});

describe("contentTypeFor", () => {
	test("maps the types the SPA actually ships", () => {
		expect(contentTypeFor("/assets/index-abc12345.js")).toBe("text/javascript; charset=utf-8");
		expect(contentTypeFor("/assets/index-abc12345.css")).toBe("text/css; charset=utf-8");
		expect(contentTypeFor("/index.html")).toBe("text/html; charset=utf-8");
		expect(contentTypeFor("/exam-lab.png")).toBe("image/png");
		expect(contentTypeFor("/favicon.ico")).toBe("image/x-icon");
		expect(contentTypeFor("/fonts/inter.woff2")).toBe("font/woff2");
		expect(contentTypeFor("/assets/index.js.map")).toBe("application/json; charset=utf-8");
	});

	test("unknown extensions fall back to octet-stream, never to text/html", () => {
		expect(contentTypeFor("/weird.qqq")).toBe("application/octet-stream");
		expect(contentTypeFor("/no-extension")).toBe("application/octet-stream");
	});
});

describe("isHashedAsset", () => {
	test("vite's hashed bundle names are hashed assets", () => {
		expect(isHashedAsset("/assets/index-D-YyJTvy.js")).toBe(true);
		expect(isHashedAsset("/assets/index-B5Bbbc5g.css")).toBe(true);
		expect(isHashedAsset("/assets/exam-lab-0ctbpnEf.png")).toBe(true);
		expect(isHashedAsset("/assets/react-pdf.browser-CC5W9Rb6.js")).toBe(true);
	});

	test("unhashed files are never treated as hashed, wherever they live", () => {
		expect(isHashedAsset("/exam-lab.png")).toBe(false);
		expect(isHashedAsset("/sw.js")).toBe(false);
		expect(isHashedAsset("/index.html")).toBe(false);
		// Right shape, wrong directory: only /assets/ is content-hashed by vite.
		expect(isHashedAsset("/vendor/index-D-YyJTvy.js")).toBe(false);
	});

	test("a too-short suffix is not a content hash", () => {
		expect(isHashedAsset("/assets/index-ab.js")).toBe(false);
	});
});

describe("cacheControlFor", () => {
	test("hashed assets are immutable for a year", () => {
		expect(cacheControlFor("/assets/index-D-YyJTvy.js")).toBe(
			`public, max-age=${IMMUTABLE_MAX_AGE}, immutable`,
		);
	});

	test("the html shell and the service worker always revalidate", () => {
		expect(cacheControlFor("/index.html")).toBe("no-cache");
		expect(cacheControlFor("/")).toBe("no-cache");
		expect(cacheControlFor("/sw.js")).toBe("no-cache");
	});

	test("unhashed public files get a short shared lifetime", () => {
		expect(cacheControlFor("/exam-lab.png")).toBe(`public, max-age=${PUBLIC_MAX_AGE}`);
		expect(cacheControlFor("/favicon.ico")).toBe(`public, max-age=${PUBLIC_MAX_AGE}`);
	});

	test("no static response is ever left without a cache directive", () => {
		for (const route of ["/", "/index.html", "/sw.js", "/runable.js", "/assets/x-abcd1234.js"]) {
			expect(cacheControlFor(route).length).toBeGreaterThan(0);
		}
	});
});

describe("isCompressible", () => {
	test("text-ish payloads compress", () => {
		expect(isCompressible("text/javascript; charset=utf-8", 2_108_679)).toBe(true);
		expect(isCompressible("text/css; charset=utf-8", 49_473)).toBe(true);
		expect(isCompressible("text/html; charset=utf-8", 606)).toBe(true);
		expect(isCompressible("image/svg+xml", 5_000)).toBe(true);
		expect(isCompressible("application/json; charset=utf-8", 5_000)).toBe(true);
		expect(isCompressible("application/wasm", 5_000)).toBe(true);
	});

	test("already-compressed binaries do not", () => {
		expect(isCompressible("image/png", 1_029_679)).toBe(false);
		expect(isCompressible("image/jpeg", 200_000)).toBe(false);
		expect(isCompressible("font/woff2", 40_000)).toBe(false);
		expect(isCompressible("application/pdf", 400_000)).toBe(false);
		expect(isCompressible("video/mp4", 400_000)).toBe(false);
		expect(isCompressible("application/octet-stream", 400_000)).toBe(false);
	});

	test("tiny and huge payloads are skipped", () => {
		expect(isCompressible("text/css; charset=utf-8", MIN_COMPRESS_BYTES - 1)).toBe(false);
		expect(isCompressible("text/css; charset=utf-8", MIN_COMPRESS_BYTES)).toBe(true);
		expect(isCompressible("text/javascript", MAX_COMPRESS_BYTES)).toBe(true);
		expect(isCompressible("text/javascript", MAX_COMPRESS_BYTES + 1)).toBe(false);
	});
});

describe("etagFor", () => {
	test("differs when size or mtime differs", () => {
		const a = etagFor(1000, 1_700_000_000_000);
		expect(a).not.toBe(etagFor(1001, 1_700_000_000_000));
		expect(a).not.toBe(etagFor(1000, 1_700_000_000_001));
	});

	test("is stable and quoted so caches treat it as a strong validator", () => {
		const tag = etagFor(1000, 1_700_000_000_000);
		expect(tag).toBe(etagFor(1000, 1_700_000_000_000));
		expect(tag.startsWith('"')).toBe(true);
		expect(tag.endsWith('"')).toBe(true);
	});

	test("fractional mtimes do not produce a decimal point in the tag", () => {
		expect(etagFor(10, 1234.75)).not.toContain(".");
	});
});

describe("buildManifest", () => {
	const manifest = buildManifest([
		{ route: "/index.html", path: "/dist/index.html", size: 606, mtimeMs: 1000 },
		{
			route: "/assets/index-D-YyJTvy.js",
			path: "/dist/assets/index-D-YyJTvy.js",
			size: 2_108_679,
			mtimeMs: 2000,
		},
		{ route: "/exam-lab.png", path: "/dist/exam-lab.png", size: 1_029_679, mtimeMs: 3000 },
	]);

	test("keys by url route and keeps the on-disk path", () => {
		expect([...manifest.keys()].sort()).toEqual([
			"/assets/index-D-YyJTvy.js",
			"/exam-lab.png",
			"/index.html",
		]);
		expect(manifest.get("/exam-lab.png")?.path).toBe("/dist/exam-lab.png");
	});

	test("derives policy per entry", () => {
		const bundle = manifest.get("/assets/index-D-YyJTvy.js")!;
		expect(bundle.cacheControl).toBe(`public, max-age=${IMMUTABLE_MAX_AGE}, immutable`);
		expect(bundle.compressible).toBe(true);
		expect(bundle.contentType).toBe("text/javascript; charset=utf-8");

		const shell = manifest.get("/index.html")!;
		expect(shell.cacheControl).toBe("no-cache");
		expect(shell.compressible).toBe(true);

		const image = manifest.get("/exam-lab.png")!;
		expect(image.compressible).toBe(false);
		expect(image.cacheControl).toBe(`public, max-age=${PUBLIC_MAX_AGE}`);
	});

	test("etags are per-file", () => {
		expect(manifest.get("/index.html")?.etag).not.toBe(manifest.get("/exam-lab.png")?.etag);
	});
});

describe("routeFor", () => {
	test("normalises to a single leading slash", () => {
		expect(routeFor("/assets/index-D-YyJTvy.js")).toBe("/assets/index-D-YyJTvy.js");
		expect(routeFor("//assets//index.js")).toBe("/assets/index.js");
		expect(routeFor("/")).toBe("/");
		expect(routeFor("")).toBe("/");
	});

	test("percent-escapes are decoded", () => {
		expect(routeFor("/assets/my%20file.js")).toBe("/assets/my file.js");
	});

	test("traversal segments are dropped, not resolved", () => {
		expect(routeFor("/../../.env")).toBe("/.env");
		expect(routeFor("/assets/../../../etc/passwd")).toBe("/assets/etc/passwd");
		expect(routeFor("/%2e%2e/%2e%2e/.env")).toBe("/.env");
		expect(routeFor("/./assets/./x.js")).toBe("/assets/x.js");
	});

	test("a malformed escape does not throw", () => {
		expect(routeFor("/%E0%A4%A")).toBe("/%E0%A4%A");
	});

	test("dots inside a filename survive", () => {
		expect(routeFor("/assets/react-pdf.browser-CC5W9Rb6.js")).toBe(
			"/assets/react-pdf.browser-CC5W9Rb6.js",
		);
	});
});

describe("parseAcceptEncoding", () => {
	test("reads tokens and qualities", () => {
		const parsed = parseAcceptEncoding("gzip, br;q=0.8, *;q=0.1");
		expect(parsed.get("gzip")).toBe(1);
		expect(parsed.get("br")).toBe(0.8);
		expect(parsed.get("*")).toBe(0.1);
	});

	test("case and spacing are tolerated", () => {
		const parsed = parseAcceptEncoding("  GZIP ;Q=0.5 ");
		expect(parsed.get("gzip")).toBe(0.5);
	});

	test("missing or empty header yields nothing", () => {
		expect(parseAcceptEncoding(null).size).toBe(0);
		expect(parseAcceptEncoding(undefined).size).toBe(0);
		expect(parseAcceptEncoding("").size).toBe(0);
	});

	test("an unparseable q is treated as not acceptable", () => {
		expect(parseAcceptEncoding("br;q=abc").get("br")).toBe(0);
	});
});

describe("negotiateEncoding", () => {
	const both: Encoding[] = ["br", "gzip"];

	test("prefers brotli when both are held and accepted", () => {
		expect(negotiateEncoding("gzip, deflate, br", both)).toBe("br");
	});

	test("falls back to gzip when brotli is not accepted or not held", () => {
		expect(negotiateEncoding("gzip, deflate", both)).toBe("gzip");
		expect(negotiateEncoding("gzip, br", ["gzip"])).toBe("gzip");
	});

	test("q=0 means refused", () => {
		expect(negotiateEncoding("br;q=0, gzip", both)).toBe("gzip");
		expect(negotiateEncoding("br;q=0, gzip;q=0", both)).toBe(null);
	});

	test("explicit quality order wins over the brotli-first default", () => {
		expect(negotiateEncoding("br;q=0.2, gzip;q=0.9", both)).toBe("gzip");
	});

	test("a wildcard covers encodings the client did not list", () => {
		expect(negotiateEncoding("*", both)).toBe("br");
		expect(negotiateEncoding("identity;q=1, *;q=0.5", ["gzip"])).toBe("gzip");
	});

	test("no header, no variants, or nothing acceptable means identity", () => {
		expect(negotiateEncoding(null, both)).toBe(null);
		expect(negotiateEncoding("gzip, br", [])).toBe(null);
		expect(negotiateEncoding("identity", both)).toBe(null);
	});
});

describe("etagMatches", () => {
	test("matches an exact tag, a list, and a weak form", () => {
		expect(etagMatches('"abc"', '"abc"')).toBe(true);
		expect(etagMatches('"other", "abc"', '"abc"')).toBe(true);
		expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
		expect(etagMatches("*", '"abc"')).toBe(true);
	});

	test("does not match a different tag or a missing header", () => {
		expect(etagMatches('"abd"', '"abc"')).toBe(false);
		expect(etagMatches(null, '"abc"')).toBe(false);
		expect(etagMatches("", '"abc"')).toBe(false);
		expect(etagMatches("abc", '"abc"')).toBe(false);
	});
});

describe("planResponse", () => {
	const sizes = (encoding: Encoding) => (encoding === "br" ? 430_000 : 538_025);

	test("serves the negotiated variant with an exact content-length", () => {
		const plan = planResponse(
			entry(),
			{ method: "GET", acceptEncoding: "gzip, br" },
			["br", "gzip"],
			sizes,
		);
		expect(plan.status).toBe(200);
		expect(plan.encoding).toBe("br");
		expect(plan.body).toBe(true);
		expect(plan.headers["Content-Encoding"]).toBe("br");
		expect(plan.headers["Content-Length"]).toBe("430000");
		expect(plan.headers.Vary).toBe("Accept-Encoding");
		expect(plan.headers["Cache-Control"]).toBe(
			`public, max-age=${IMMUTABLE_MAX_AGE}, immutable`,
		);
		expect(plan.headers.ETag).toBe('"abc-def"');
	});

	test("serves identity when no variant is ready yet", () => {
		const plan = planResponse(entry(), { method: "GET", acceptEncoding: "gzip, br" }, []);
		expect(plan.encoding).toBe(null);
		expect(plan.headers["Content-Encoding"]).toBeUndefined();
		expect(plan.headers["Content-Length"]).toBe("2108679");
		// Still advertises the vary so a shared cache cannot pin identity for all.
		expect(plan.headers.Vary).toBe("Accept-Encoding");
	});

	test("never compresses an incompressible entry", () => {
		const plan = planResponse(
			entry({ compressible: false, contentType: "image/png", size: 1_029_679 }),
			{ method: "GET", acceptEncoding: "gzip, br" },
			["br", "gzip"],
			sizes,
		);
		expect(plan.encoding).toBe(null);
		expect(plan.headers.Vary).toBeUndefined();
		expect(plan.headers["Content-Length"]).toBe("1029679");
	});

	test("a matching If-None-Match yields a bodyless 304 that still carries the policy", () => {
		const plan = planResponse(
			entry(),
			{ method: "GET", ifNoneMatch: '"abc-def"', acceptEncoding: "gzip, br" },
			["br", "gzip"],
			sizes,
		);
		expect(plan.status).toBe(304);
		expect(plan.body).toBe(false);
		expect(plan.encoding).toBe(null);
		expect(plan.headers["Content-Length"]).toBeUndefined();
		expect(plan.headers.ETag).toBe('"abc-def"');
		expect(plan.headers["Cache-Control"]).toBe(
			`public, max-age=${IMMUTABLE_MAX_AGE}, immutable`,
		);
	});

	test("a stale If-None-Match still gets the bytes", () => {
		const plan = planResponse(entry(), { method: "GET", ifNoneMatch: '"stale"' }, []);
		expect(plan.status).toBe(200);
		expect(plan.body).toBe(true);
	});

	test("HEAD keeps every header but sends no body", () => {
		const plan = planResponse(
			entry(),
			{ method: "head", acceptEncoding: "gzip" },
			["gzip"],
			sizes,
		);
		expect(plan.status).toBe(200);
		expect(plan.body).toBe(false);
		expect(plan.headers["Content-Length"]).toBe("538025");
		expect(plan.headers["Content-Encoding"]).toBe("gzip");
	});

	test("omits content-length rather than lying when the variant size is unknown", () => {
		const plan = planResponse(
			entry(),
			{ method: "GET", acceptEncoding: "gzip" },
			["gzip"],
			() => undefined,
		);
		expect(plan.encoding).toBe("gzip");
		expect(plan.headers["Content-Length"]).toBeUndefined();
	});
});

describe("CompressedAssets", () => {
	const fakeCompress = (bytes: Uint8Array, encoding: Encoding) =>
		Promise.resolve(new Uint8Array(encoding === "br" ? 10 : 20).fill(bytes[0] ?? 1));

	test("warms both variants and reports what is available", async () => {
		const cache = new CompressedAssets(fakeCompress, async () => new Uint8Array(1000).fill(7));
		expect(cache.available("/a.js")).toEqual([]);

		await cache.warm("/a.js", entry({ path: "/dist/a.js", size: 1000 }));

		expect(cache.available("/a.js")).toEqual(["br", "gzip"]);
		expect(cache.sizeOf("/a.js", "br")).toBe(10);
		expect(cache.sizeOf("/a.js", "gzip")).toBe(20);
		expect(cache.get("/a.js", "br")?.[0]).toBe(7);
		expect(cache.heldBytes).toBe(30);
	});

	test("does not compress an incompressible entry", async () => {
		let reads = 0;
		const cache = new CompressedAssets(fakeCompress, async () => {
			reads += 1;
			return new Uint8Array(10);
		});
		await cache.warm("/a.png", entry({ compressible: false }));
		expect(cache.available("/a.png")).toEqual([]);
		expect(reads).toBe(0);
	});

	test("a second warm does no extra work", async () => {
		let compressions = 0;
		const cache = new CompressedAssets(
			(bytes, encoding) => {
				compressions += 1;
				return fakeCompress(bytes, encoding);
			},
			async () => new Uint8Array(1000),
		);
		await cache.warm("/a.js", entry());
		await cache.warm("/a.js", entry());
		expect(compressions).toBe(2);
	});

	test("concurrent warms of the same route do not duplicate work", async () => {
		let compressions = 0;
		const cache = new CompressedAssets(
			(bytes, encoding) => {
				compressions += 1;
				return fakeCompress(bytes, encoding);
			},
			async () => new Uint8Array(1000),
		);
		await Promise.all([
			cache.warm("/a.js", entry()),
			cache.warm("/a.js", entry()),
			cache.warm("/a.js", entry()),
		]);
		expect(compressions).toBe(2);
		expect(cache.available("/a.js")).toEqual(["br", "gzip"]);
	});

	test("drops a variant that is not actually smaller", async () => {
		const cache = new CompressedAssets(
			async () => new Uint8Array(1000),
			async () => new Uint8Array(1000),
		);
		await cache.warm("/a.js", entry({ size: 1000 }));
		expect(cache.available("/a.js")).toEqual([]);
		expect(cache.heldBytes).toBe(0);
	});

	test("stops caching once the memory budget is spent", async () => {
		const cache = new CompressedAssets(fakeCompress, async () => new Uint8Array(1000), 15);
		await cache.warm("/a.js", entry());
		// br (10 bytes) fits; the budget is then spent, so gzip is skipped.
		expect(cache.available("/a.js")).toEqual(["br"]);
		await cache.warm("/b.js", entry({ path: "/dist/b.js" }));
		expect(cache.available("/b.js")).toEqual([]);
		expect(cache.heldBytes).toBe(10);
	});

	test("a read or compress failure leaves the asset servable as identity", async () => {
		const failRead = new CompressedAssets(fakeCompress, async () => {
			throw new Error("ENOENT");
		});
		await failRead.warm("/a.js", entry());
		expect(failRead.available("/a.js")).toEqual([]);

		const failCompress = new CompressedAssets(
			async () => {
				throw new Error("zlib blew up");
			},
			async () => new Uint8Array(1000),
		);
		await failCompress.warm("/a.js", entry());
		expect(failCompress.available("/a.js")).toEqual([]);
	});

	test("a failed warm can be retried", async () => {
		let attempt = 0;
		const cache = new CompressedAssets(fakeCompress, async () => {
			attempt += 1;
			if (attempt === 1) throw new Error("transient");
			return new Uint8Array(1000);
		});
		await cache.warm("/a.js", entry());
		expect(cache.available("/a.js")).toEqual([]);
		await cache.warm("/a.js", entry());
		expect(cache.available("/a.js")).toEqual(["br", "gzip"]);
	});

	test("warmInBackground never rejects into the request path", async () => {
		const cache = new CompressedAssets(fakeCompress, async () => {
			throw new Error("boom");
		});
		expect(() => cache.warmInBackground("/a.js", entry())).not.toThrow();
		await Bun.sleep(1);
		expect(cache.available("/a.js")).toEqual([]);
	});

	test("variants are keyed per route, not shared", async () => {
		const cache = new CompressedAssets(fakeCompress, async (path) =>
			new Uint8Array(1000).fill(path === "/dist/a.js" ? 1 : 2),
		);
		await cache.warm("/a.js", entry({ path: "/dist/a.js" }));
		await cache.warm("/b.js", entry({ path: "/dist/b.js" }));
		expect(cache.get("/a.js", "br")?.[0]).toBe(1);
		expect(cache.get("/b.js", "br")?.[0]).toBe(2);
	});
});

describe("end-to-end policy for the routes that broke at 1000 students", () => {
	test("the student bundle is compressed, immutable and revalidatable", async () => {
		const manifest = buildManifest([
			{
				route: "/assets/index-D-YyJTvy.js",
				path: "/dist/assets/index-D-YyJTvy.js",
				size: 2_108_679,
				mtimeMs: 1_700_000_000_000,
			},
		]);
		const bundle = manifest.get("/assets/index-D-YyJTvy.js")!;
		const cache = new CompressedAssets(
			async () => new Uint8Array(538_025),
			async () => new Uint8Array(2_108_679),
		);
		await cache.warm("/assets/index-D-YyJTvy.js", bundle);

		const first = planResponse(
			bundle,
			{ method: "GET", acceptEncoding: "gzip, deflate, br" },
			cache.available("/assets/index-D-YyJTvy.js"),
			(encoding) => cache.sizeOf("/assets/index-D-YyJTvy.js", encoding),
		);
		expect(first.status).toBe(200);
		expect(first.headers["Content-Encoding"]).toBe("br");
		expect(Number(first.headers["Content-Length"])).toBeLessThan(2_108_679 / 3);

		const refresh = planResponse(bundle, {
			method: "GET",
			ifNoneMatch: first.headers.ETag,
			acceptEncoding: "gzip, deflate, br",
		});
		expect(refresh.status).toBe(304);
		expect(refresh.body).toBe(false);
	});

	test("a redeploy changes the shell's etag so students do not get pinned to old html", () => {
		const before = buildManifest([
			{ route: "/index.html", path: "/dist/index.html", size: 606, mtimeMs: 1000 },
		]).get("/index.html")!;
		const after = buildManifest([
			{ route: "/index.html", path: "/dist/index.html", size: 612, mtimeMs: 5000 },
		]).get("/index.html")!;
		expect(after.etag).not.toBe(before.etag);
		expect(planResponse(after, { method: "GET", ifNoneMatch: before.etag }).status).toBe(200);
	});
});
