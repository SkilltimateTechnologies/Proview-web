import { hc } from "hono/client";
import type { AppType } from "../../api";
import { getBearer } from "./auth";

/** Super-admin college scope (persisted). Empty = platform-wide / own tenant. */
export function getScope(): string {
  try {
    return localStorage.getItem("examly_scope") ?? "";
  } catch {
    return "";
  }
}
export function setScope(tenantId: string) {
  try {
    if (tenantId) localStorage.setItem("examly_scope", tenantId);
    else localStorage.removeItem("examly_scope");
  } catch {
    /* ignore */
  }
}

const client = hc<AppType>("/", {
  headers: () => {
    const token = getBearer();
    const scope = getScope();
    const h: Record<string, string> = {};
    if (token) h.Authorization = `Bearer ${token}`;
    if (scope) h["X-Tenant-Id"] = scope;
    return h;
  },
});

export const api = client.api;

/**
 * Attach a JSON body to a call whose route reads `c.req.json()` without a
 * declared validator (most staff routes): the typed client then does not know
 * the body exists. The parameters stay type-checked; the body is sent as-is.
 *
 *   api.exams[":id"].$patch(withBody({ param: { id } }, { title }))
 */
export function withBody<T extends object>(args: T, json: unknown): T {
  return { ...args, json } as T;
}

type ErrorShape = { message: string } | { error: string };

/**
 * Read a successful response, or throw with the server's message. Route types
 * are a union of the success body and the error body; this narrows to the
 * success body, so a failed request surfaces as an error instead of an
 * `undefined` read further down.
 */
export async function data<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(
  res: R,
): Promise<Exclude<Awaited<ReturnType<R["json"]>>, ErrorShape>> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message || body.error || `Request failed (${res.status})`);
  }
  return (await res.json()) as Exclude<Awaited<ReturnType<R["json"]>>, ErrorShape>;
}

/** Same as withBody, for a route that reads `c.req.query()` without a declared validator. */
export function withQuery<T extends object>(args: T, query: Record<string, string>): T {
  return { ...args, query } as T;
}
