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
