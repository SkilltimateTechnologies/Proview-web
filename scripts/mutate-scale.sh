#!/usr/bin/env bash
# Mutation test for the two modules the scale fix added: the static-asset serving
# policy and the TTL read cache. A test suite that passes against broken source is
# decoration — each mutant below is a plausible way to get this wrong, and every one
# must make at least one test fail.
#
#   bash scripts/mutate-scale.sh
set -uo pipefail
cd "$(dirname "$0")/.."

STATIC=src/api/lib/static-assets.ts
CACHE=src/api/lib/ttl-cache.ts
STATIC_TEST=src/api/lib/static-assets.test.ts
CACHE_TEST=src/api/lib/ttl-cache.test.ts
BAK_STATIC=$(mktemp)
BAK_CACHE=$(mktemp)
cp "$STATIC" "$BAK_STATIC"
cp "$CACHE" "$BAK_CACHE"
restore() { cp "$BAK_STATIC" "$STATIC"; cp "$BAK_CACHE" "$CACHE"; }
trap 'restore; rm -f "$BAK_STATIC" "$BAK_CACHE"' EXIT

killed=0; survived=0; n=0

mutant() { # name, file, test file, "old|||new"
  n=$((n+1))
  restore
  python3 - "$2" "$4" <<'PY'
import sys
path, expr = sys.argv[1], sys.argv[2]
s = open(path).read()
old, new = expr.split("|||")
if old not in s:
    print("PATCH-MISS"); sys.exit(3)
open(path, "w").write(s.replace(old, new, 1))
PY
  if [ $? -eq 3 ]; then echo "  [$n] $1 -> PATCH DID NOT APPLY (mutant invalid)"; survived=$((survived+1)); return; fi
  if bun test "$3" >/tmp/mut-scale.log 2>&1; then
    echo "  [$n] $1 -> SURVIVED  <-- tests do not cover this"
    survived=$((survived+1))
  else
    echo "  [$n] $1 -> killed ($(grep -cE '^\(fail\)' /tmp/mut-scale.log) failing)"
    killed=$((killed+1))
  fi
}

echo "mutating $STATIC"

# The whole incident: assets went out with no cache headers at all.
mutant "hashed assets are no longer immutable" "$STATIC" "$STATIC_TEST" \
  'if (isHashedAsset(route)) return `public, max-age=${IMMUTABLE_MAX_AGE}, immutable`;|||if (isHashedAsset(route)) return "no-cache";'

# Caching the HTML shell or the service worker for a year pins students to a bundle
# that no longer matches the API.
mutant "the html shell becomes cacheable" "$STATIC" "$STATIC_TEST" \
  'if (route === "/index.html" || route === "/" || route === "/sw.js") {|||if (route === "/nothing-matches-this") {'

mutant "everything is treated as content-hashed" "$STATIC" "$STATIC_TEST" \
  'if (!route.startsWith("/assets/")) return false;|||if (!route.startsWith("/assets/")) return true;'

mutant "any suffix counts as a content hash" "$STATIC" "$STATIC_TEST" \
  'return /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(name);|||return /-[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(name);'

# Compressing an already-compressed binary burns CPU for nothing; refusing to
# compress JavaScript is the bug we started from.
mutant "javascript is no longer compressible" "$STATIC" "$STATIC_TEST" \
  'if (type.startsWith("text/")) return true;|||if (type.startsWith("text/")) return false;'

mutant "images are compressed too" "$STATIC" "$STATIC_TEST" \
  'if (type === "image/svg+xml") return true;|||if (type.startsWith("image/")) return true;'

mutant "the compression size ceiling is ignored" "$STATIC" "$STATIC_TEST" \
  'if (size < MIN_COMPRESS_BYTES || size > MAX_COMPRESS_BYTES) return false;|||if (size < MIN_COMPRESS_BYTES) return false;'

# ETag correctness: a validator that never changes serves a stale bundle forever.
mutant "etag ignores the file size" "$STATIC" "$STATIC_TEST" \
  'return `"${size.toString(36)}-${stamp}"`;|||return `"${stamp}"`;'

mutant "etag ignores the mtime" "$STATIC" "$STATIC_TEST" \
  'return `"${size.toString(36)}-${stamp}"`;|||return `"${size.toString(36)}"`;'

mutant "if-none-match matches anything" "$STATIC" "$STATIC_TEST" \
  'if (normalized === etag) return true;|||if (normalized.length > 0) return true;'

mutant "if-none-match never matches a weak validator" "$STATIC" "$STATIC_TEST" \
  'const normalized = token.startsWith("W/") ? token.slice(2) : token;|||const normalized = token;'

# Traversal: dist is next to .env and the whole repo.
mutant "traversal segments are kept" "$STATIC" "$STATIC_TEST" \
  '.filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");|||.filter((segment) => segment.length > 0);'

# Negotiation: sending brotli to a client that refused it breaks the page outright.
mutant "q=0 is treated as acceptable" "$STATIC" "$STATIC_TEST" \
  'if (quality > bestQuality) {|||if (quality >= bestQuality) {'

mutant "encoding is chosen even with no header" "$STATIC" "$STATIC_TEST" \
  'if (accepted.size === 0) return null;|||if (accepted.size === 0) return available[0] ?? null;'

mutant "gzip is preferred over brotli" "$STATIC" "$STATIC_TEST" \
  'for (const candidate of ["br", "gzip"] as const) {|||for (const candidate of ["gzip", "br"] as const) {'

mutant "an unheld variant can still be selected" "$STATIC" "$STATIC_TEST" \
  'if (!available.includes(candidate)) continue;|||if (false) continue;'

# Response shaping: a wrong Content-Length or a 304 with a body breaks every client.
mutant "304 responses carry a body" "$STATIC" "$STATIC_TEST" \
  'return { status: 304, headers, encoding: null, body: false };|||return { status: 304, headers, encoding: null, body: true };'

mutant "HEAD responses carry a body" "$STATIC" "$STATIC_TEST" \
  'return { status: 200, headers, encoding, body: method !== "HEAD" };|||return { status: 200, headers, encoding, body: true };'

mutant "content-length reports the identity size when compressed" "$STATIC" "$STATIC_TEST" \
  'const length = encoding ? encodedSize?.(encoding) : entry.size;|||const length = entry.size;'

mutant "vary: accept-encoding is dropped" "$STATIC" "$STATIC_TEST" \
  'if (entry.compressible) headers.Vary = "Accept-Encoding";|||if (false) headers.Vary = "Accept-Encoding";'

mutant "if-none-match is checked after encoding is chosen" "$STATIC" "$STATIC_TEST" \
  'if (etagMatches(request.ifNoneMatch, entry.etag)) {|||if (false) {'

# The in-memory variant store.
mutant "a bigger 'compressed' variant is kept" "$STATIC" "$STATIC_TEST" \
  'if (compressed.byteLength >= identity.byteLength) continue;|||if (false) continue;'

mutant "the memory budget can be overshot" "$STATIC" "$STATIC_TEST" \
  'if (this.bytesHeld + compressed.byteLength > this.budgetBytes) break;|||if (false) break;'

mutant "concurrent warms duplicate the work" "$STATIC" "$STATIC_TEST" \
  'if (this.pending.has(route)) return;|||if (false) return;'

mutant "a failed warm is never retried" "$STATIC" "$STATIC_TEST" \
  '			this.pending.delete(route);|||			if (this.variants.size) this.pending.delete(route);'

mutant "incompressible entries are read from disk anyway" "$STATIC" "$STATIC_TEST" \
  'if (!entry.compressible) return;|||if (false) return;'

mutant "variants are shared across routes" "$STATIC" "$STATIC_TEST" \
  'return `${encoding} ${route}`;|||return `${encoding}`;'

echo
echo "mutating $CACHE"

mutant "entries never expire" "$CACHE" "$CACHE_TEST" \
  'if (hit.expiresAt <= this.now()) {|||if (false) {'

mutant "expiry is off by one ttl boundary" "$CACHE" "$CACHE_TEST" \
  'if (hit.expiresAt <= this.now()) {|||if (hit.expiresAt < this.now() - this.ttlMs) {'

mutant "the ttl is ignored on write" "$CACHE" "$CACHE_TEST" \
  'this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });|||this.entries.set(key, { value, expiresAt: Number.MAX_SAFE_INTEGER });'

mutant "invalidate does nothing" "$CACHE" "$CACHE_TEST" \
  '	invalidate(key: string): void {
		this.entries.delete(key);|||	invalidate(key: string): void {
		void key;'

mutant "invalidate clears everything" "$CACHE" "$CACHE_TEST" \
  '	invalidate(key: string): void {
		this.entries.delete(key);|||	invalidate(key: string): void {
		void key;
		this.entries.clear();'

mutant "concurrent loads are not coalesced" "$CACHE" "$CACHE_TEST" \
  'if (existing) return existing;|||if (false) return existing!;'

mutant "a rejected load stays in flight forever" "$CACHE" "$CACHE_TEST" \
  '			} finally {
				this.inFlight.delete(key);
			}|||			} finally {
				/* leak the in-flight entry */
			}'

mutant "the loader result is not cached" "$CACHE" "$CACHE_TEST" \
  '				const value = await loader();
				this.set(key, value);|||				const value = await loader();'

mutant "the max-entries cap is removed" "$CACHE" "$CACHE_TEST" \
  'if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {|||if (false) {'

mutant "overwriting at the cap wipes the cache" "$CACHE" "$CACHE_TEST" \
  'if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {|||if (this.entries.size >= this.maxEntries) {'

restore
echo
echo "killed=$killed survived=$survived of $n"
if bun test "$STATIC_TEST" "$CACHE_TEST" >/dev/null 2>&1; then
  echo "source restored, suite green"
else
  echo "SOURCE NOT RESTORED CLEANLY"; exit 1
fi
[ "$survived" -eq 0 ] || exit 1
