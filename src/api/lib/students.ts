/**
 * Roll-number rules shared by every student write path.
 *
 * These live in their own module (rather than inline in the route file) so they can
 * be unit-tested by `bun test`, which the build runs. The duplicate-student incident
 * was caused by three write paths each applying a slightly different rule; the only
 * way that stays fixed is one implementation with tests around it.
 */

/**
 * Roll numbers, canonicalised.
 *
 * WHY: the same student can enter the system through three doors — a TPO adding
 * them by hand, a CSV bulk import, and the public self-registration page. Each
 * door produced a different spelling of the same roll number, and because the
 * duplicate check was an exact string match, none of them collided:
 *
 *   "23k91a0491" / " 23K91A0491 " / "23K91A0491"  → three separate students
 *
 * Worse, students self-registering typed their college EMAIL into the roll field,
 * so "23K91A0491@TKRCET.COM" sailed past a check for "23K91A0491" and created a
 * second record — splitting one person's results across two rows and making them
 * appear twice in reports and the Live Monitor.
 *
 * Every write path now runs the raw value through here, and the DB enforces
 * uniqueness on the same expression (see `students_tenant_roll_uq` in
 * invariants.ts) so a race cannot slip a duplicate in behind the check.
 */
export function normalizeRoll(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

/**
 * Reject values that cannot be a roll number, with a message a TPO can act on.
 * Returns null when the value is acceptable.
 */
export function rollNoProblem(roll: string): string | null {
  if (!roll) return "Roll number is required";
  // The single most common real-world mistake: pasting the college email.
  if (roll.includes("@")) return "That looks like an email address, not a roll number";
  if (roll.length < 4) return "Roll number is too short";
  if (roll.length > 20) return "Roll number is too long";
  if (!/^[A-Z0-9-]+$/.test(roll)) return "Roll number may only contain letters, digits and hyphens";
  return null;
}


/**
 * True when an error is the students-roll uniqueness index rejecting a write.
 *
 * The SQLite message ("UNIQUE constraint failed: index 'students_tenant_roll_uq'")
 * is NOT on the error we catch: drizzle wraps it in a DrizzleQueryError whose own
 * message is just "Failed query: insert into ...". Matching only the top-level
 * message turned a lost race into a 500 (measured: 6 concurrent identical creates
 * gave 1x201 + 5x500). Walk the cause chain.
 */
export function isDuplicateRollError(e: unknown): boolean {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 6; depth++) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  const msg = parts.join(" | ");
  if (/students_tenant_roll_uq/i.test(msg)) return true;
  return /UNIQUE constraint failed/i.test(msg) && /students/i.test(msg);
}
