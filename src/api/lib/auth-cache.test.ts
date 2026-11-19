/**
 * The identity cache sits in front of every staff request. The dangerous failure
 * is not a stale read for a few seconds — it is ONE request's per-request change
 * (a super admin's X-Tenant-Id scope) leaking into another request through a
 * shared object, or a credential-less request being served someone's identity.
 */
import { describe, expect, test } from "bun:test";
import { AuthCache } from "./auth-cache";

type U = { id: string };
type P = { userId: string; tenantId: string | null; role: string; permissions: Record<string, boolean> | null };

const ident = (tenantId: string | null = "ten_a") => ({
  user: { id: "u1" },
  profile: { userId: "u1", tenantId, role: "super_admin", permissions: { reports: true } } as P,
  defaultTenantId: null,
});

describe("AuthCache", () => {
  test("serves repeat requests from memory within the TTL", async () => {
    let t = 0; let loads = 0;
    const cache = new AuthCache<U, P>(10_000, () => t);
    const key = AuthCache.keyOf("Bearer abc", "");
    await cache.resolve(key, async () => { loads++; return ident(); });
    t = 9_999;
    await cache.resolve(key, async () => { loads++; return ident(); });
    expect(loads).toBe(1);
    t = 10_000;
    await cache.resolve(key, async () => { loads++; return ident(); });
    expect(loads).toBe(2);
  });

  test("every caller gets its own copy: a per-request scope change never leaks", async () => {
    const cache = new AuthCache<U, P>();
    const key = AuthCache.keyOf("Bearer abc", "");
    const first = await cache.resolve(key, async () => ident(null));
    first.profile!.tenantId = "ten_scoped_by_header";
    first.profile!.permissions!.reports = false;
    const second = await cache.resolve(key, async () => ident(null));
    expect(second.profile!.tenantId).toBeNull();
    expect(second.profile!.permissions!.reports).toBe(true);
  });

  test("no credentials: never cached, always loaded", async () => {
    let loads = 0;
    const cache = new AuthCache<U, P>();
    expect(AuthCache.keyOf(undefined, "  ")).toBe("");
    await cache.resolve("", async () => { loads++; return { user: null, profile: null, defaultTenantId: null }; });
    await cache.resolve("", async () => { loads++; return { user: null, profile: null, defaultTenantId: null }; });
    expect(loads).toBe(2);
    expect(cache.size).toBe(0);
  });

  test("different credentials never share an entry", async () => {
    const cache = new AuthCache<U, P>();
    await cache.resolve(AuthCache.keyOf("Bearer a", ""), async () => ident("ten_a"));
    const other = await cache.resolve(AuthCache.keyOf("Bearer b", ""), async () => ({ ...ident("ten_b"), user: { id: "u2" } }));
    expect(other.user!.id).toBe("u2");
    expect(other.profile!.tenantId).toBe("ten_b");
  });

  test("concurrent misses for one credential load once", async () => {
    let loads = 0;
    const cache = new AuthCache<U, P>();
    const key = AuthCache.keyOf("Bearer x", "");
    await Promise.all(Array.from({ length: 10 }, () => cache.resolve(key, async () => {
      loads++; await new Promise((r) => setTimeout(r, 10)); return ident();
    })));
    expect(loads).toBe(1);
  });

  test("invalidate() drops entries, and a load racing it is not cached", async () => {
    let loads = 0;
    const cache = new AuthCache<U, P>();
    const key = AuthCache.keyOf("Bearer x", "");
    let release!: () => void;
    const pending = cache.resolve(key, async () => { loads++; await new Promise<void>((r) => (release = r)); return ident(); });
    await Promise.resolve();
    cache.invalidate();
    release();
    await pending;
    expect(cache.size).toBe(0);
    await cache.resolve(key, async () => { loads++; return ident(); });
    expect(loads).toBe(2);
  });

  test("a failed load is not cached", async () => {
    const cache = new AuthCache<U, P>();
    const key = AuthCache.keyOf("Bearer x", "");
    await expect(cache.resolve(key, async () => { throw new Error("db down"); })).rejects.toThrow("db down");
    const ok = await cache.resolve(key, async () => ident());
    expect(ok.user!.id).toBe("u1");
  });
});
