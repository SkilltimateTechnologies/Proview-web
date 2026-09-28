import { os, type RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { z } from "zod";
import { authorizeReset, resetScopeSchema, type BulkStudentPasswords, type ResetActor } from "../lib/bulk-student-passwords";

export type BulkResetContext = { profile: ResetActor | null; service: BulkStudentPasswords };
const base = os.$context<BulkResetContext>();
export const bulkStudentPasswordsRouter = {
  preview: base.input(resetScopeSchema).handler(({ input, context }) => {
    authorizeReset(context.profile, input.tenantId);
    return context.service.preview(context.profile, input);
  }),
  reset: base.input(z.object({ target: resetScopeSchema, confirmationToken: z.string().min(1).max(4096), acknowledged: z.literal(true) }).strict())
    .handler(({ input, context }) => {
      authorizeReset(context.profile, input.target.tenantId);
      return context.service.reset(context.profile, input.target, input.confirmationToken);
    }),
};
export const bulkResetRouter = { bulkStudentPasswords: bulkStudentPasswordsRouter };
export type BulkResetClient = RouterClient<typeof bulkResetRouter>;
export const bulkResetHandler = new RPCHandler(bulkResetRouter);
