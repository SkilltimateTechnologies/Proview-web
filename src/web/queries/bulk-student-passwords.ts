import { bulkResetOrpc } from "../lib/bulk-reset-api";
export const previewStudentPasswords = () => bulkResetOrpc.bulkStudentPasswords.preview.mutationOptions({ retry: false });
export const resetStudentPasswords = () => bulkResetOrpc.bulkStudentPasswords.reset.mutationOptions({ retry: false });
