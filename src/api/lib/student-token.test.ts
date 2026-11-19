/**
 * Student tokens now expire (they used to be valid forever). The risk of adding
 * expiry is cutting a student off mid-exam, so pin both directions: a fresh
 * token works, an old one does not, a forged or malformed one never does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { STUDENT_TOKEN_DEFAULT_MAX_AGE_MS, signStudentToken, verifyStudentToken } from "./student-token";

const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
  delete process.env.STUDENT_TOKEN_MAX_AGE_MS;
});

describe("student token expiry", () => {
  test("a fresh token verifies to its student", async () => {
    const t = await signStudentToken("stu_abc");
    expect(await verifyStudentToken(t)).toBe("stu_abc");
  });

  test("still valid just inside the default window, rejected just past it", async () => {
    const t = await signStudentToken("stu_abc");
    const issued = realNow();
    Date.now = () => issued + STUDENT_TOKEN_DEFAULT_MAX_AGE_MS - 60_000;
    expect(await verifyStudentToken(t)).toBe("stu_abc");
    Date.now = () => issued + STUDENT_TOKEN_DEFAULT_MAX_AGE_MS + 60_000;
    expect(await verifyStudentToken(t)).toBeNull();
  });

  test("the window can be set by environment", async () => {
    process.env.STUDENT_TOKEN_MAX_AGE_MS = "1000";
    const t = await signStudentToken("stu_abc");
    const issued = realNow();
    Date.now = () => issued + 5000;
    expect(await verifyStudentToken(t)).toBeNull();
  });

  test("tampered, malformed and empty tokens never verify", async () => {
    const t = await signStudentToken("stu_abc");
    const [p, sig] = t.split(".");
    const forged = Buffer.from("stu_other." + Date.now()).toString("base64url");
    expect(await verifyStudentToken(`${forged}.${sig}`)).toBeNull();
    expect(await verifyStudentToken(`${p}.AAAA`)).toBeNull();
    expect(await verifyStudentToken("garbage")).toBeNull();
    expect(await verifyStudentToken("")).toBeNull();
    expect(await verifyStudentToken(undefined)).toBeNull();
  });
});
