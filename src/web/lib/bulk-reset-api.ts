import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { BulkResetClient } from "../../api/routes/bulk-student-passwords";
import { getBearer } from "./auth";
import { getScope } from "./api";

const link = new RPCLink({
  url: `${window.location.origin}/api/rpc`,
  headers: () => {
    const headers: Record<string, string> = {};
    const token = getBearer(); const scope = getScope();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (scope) headers["X-Tenant-Id"] = scope;
    return headers;
  },
});
export const bulkResetClient: BulkResetClient = createORPCClient(link);
export const bulkResetOrpc = createTanstackQueryUtils(bulkResetClient);
