# Bulk student password reset

## Approved scope
- Students in the current college only; all students or selected students.
- Existing default temporary password `Welcome@123`, mandatory change on next login.
- Feature only. No production accounts reset while developing or testing.
- Preserve current Users page design, staff/TPO accounts, enabled status and exam records.

## Implementation
- New typed oRPC procedures mounted through existing Hono authentication/users permission context.
- Service checks enabled staff role, users permission for TPO, and exact tenant scope (including superadmin).
- Tenant-bound HMAC confirmation, actor/target/credential/status snapshot, five-minute expiry.
- Transaction revalidates snapshot, updates only password and mustChangePassword, verifies count, invalidates tenant student cache.
- One salted hash per operation, matching existing bulk provisioning. Selection uses json_each to avoid bind-variable limits.
- No schema changes or migrations. Existing single reset and forced-change login flows preserved.
- Student checkboxes, cross-page selection, select-all-matching, count and confirmation dialog.
- All-college scope explicitly includes Elite and disabled accounts regardless of filters.
- Dialog supports keyboard focus trap, Escape, mobile viewport, acknowledgment and server-confirmed count.
- Reset mutation never auto-retries; uncertain network outcomes require checking before re-reviewing.

## Verified 2026-09-28
- Repository build: API typecheck, 424 passing tests / 0 failures / 22 files, Vite build successful.
- 24 new service/wire tests use disposable file-backed libSQL databases, never the app DB singleton.
- Coverage: no-write preview; selected/all scopes; mixed-tenant rejection; role and enabled checks;
  real password hash verification; staff/exam/other fields preserved; stale snapshot, tamper, expiry,
  replay; atomic rollback after injected DB failure; hash failure; missing signing secret;
  typed oRPC through Hono validates acknowledgment and unknown-route behavior.
- Web typecheck: 56 errors, identical to baseline at 3a432e7 after ignoring line/column movement.
  These are existing diagnostics, not a clean web typecheck.
- Separate managed preview uses 48 synthetic students and a synthetic administrator only.
  No production credentials copied; its database implementation never reads DATABASE_URL.
- Browser tests: cancellation makes no writes; page and cross-page selection; indeterminate
  checkbox; selection clears on filter/search; selected two-account reset including disabled;
  acknowledgment gate; all-college reset independent of filters; DB readback verifies exact
  fields; simulated network failure sends once with no retry; staff tab has no bulk button;
  keyboard focus and Escape; mobile 390x844 without horizontal overflow; zero page errors.
- Preview web/API typechecks and managed build passed. Template structural lint passed;
  full lint still reports 42 accessibility diagnostics in copied legacy Users/shared UI.
  No lint diagnostics remain in the new bulk reset dialog.
- GitHub sync completed with a freshly supplied secure credential. Feature commit
  `880f67c5a4adf5948411dae41ea61fc175830bed` was pushed to `main` and its remote hash
  verified using `git ls-remote` on 2026-09-28. The initial missing-authentication blocker
  is resolved. Production deployment and Railway signing-secret configuration are not verified.

## Deployment and honest limits
- BETTER_AUTH_SECRET must be configured (minimum 16 characters; use a strong existing secret
  shared across replicas). Feature fails closed without it. Production Railway setting unverified.
- Existing login returns mustChangePassword and student UI gates on it; inspected from code,
  not full production login E2E tested. Existing student sessions are not revoked.
- Audit is credential-free application logging, not a persistent audit table.
- Hono/oRPC integration tests inject the profile rather than sign in through Better Auth.
- Snapshot binds IDs/password hashes/must-change/enabled fields, not names or classes.
- Preview is a safe demonstration, not production deployment. No real passwords were reset.
- All repository build/test commands override DATABASE_URL to a local file and blank its token.
