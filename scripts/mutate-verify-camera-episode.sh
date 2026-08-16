#!/usr/bin/env bash
# Mutation test for scripts/verify-camera-episode.py.
#
# The browser check is the only thing that can see the WIRING — unit tests cannot
# reach the component's timers, the 2.5s recovery poll or real getUserMedia
# handles. So it needs the same treatment the state machine got: break the fix on
# purpose and the check must go red. A green browser check against a broken build
# would be worse than no check at all, since it is the one people will trust.
#
# The two mutants are the two ways this has ACTUALLY been got wrong: the original
# bug (bill every detection), and the leak the first version of this fix shipped
# with (treat the exam resuming as proof the camera works — the browser run caught
# that one, no unit test did).
#
# ~3 minutes per mutant: full rebuild, fresh seed, real exam.
set -uo pipefail
cd "$(dirname "$0")/.."

SRC=src/web/student/lib/camera-episode.ts
RUN=src/web/student/pages/exam-runner.tsx
BS=$(mktemp); BR=$(mktemp)
cp "$SRC" "$BS"; cp "$RUN" "$BR"
restore() { cp "$BS" "$SRC"; cp "$BR" "$RUN"; }
trap 'restore; rm -f "$BS" "$BR"' EXIT

killed=0; survived=0; n=0

rebuild_and_run() {
  # Kill anything already holding :3100 — a stale server keeps its own handle on
  # the database file and the check would silently run against the OLD build, on
  # an attempt that is already in progress ("Resume exam" instead of "Start").
  tmux kill-session -t mut 2>/dev/null
  tmux kill-session -t mon 2>/dev/null
  sleep 1
  rm -f .tmp-verify.db*
  # `bun run build` runs the unit suite first, and mutant 1 is a bug the unit
  # tests already kill — which would abort the build instead of exercising the
  # browser check. Bundle only: this harness is asking a different question.
  env -u DATABASE_URL -u DATABASE_AUTH_TOKEN bunx vite build >/tmp/mut-build.log 2>&1 || { echo "BUILD FAILED"; return 2; }
  DATABASE_URL="file:$PWD/.tmp-verify.db" bun run db:push --force >/tmp/mut-push.log 2>&1
  DATABASE_URL="file:$PWD/.tmp-verify.db" bun run seed >/tmp/mut-seed.log 2>&1
  python3 scripts/verify-camera-episode.py --prepare >/dev/null
  tmux new-session -d -s mut "cd $PWD && DATABASE_URL=\"file:$PWD/.tmp-verify.db\" PORT=3100 bun src/server.ts >/tmp/mut-server.log 2>&1"
  sleep 6
  curl -sf localhost:3100/api/health >/dev/null || { echo "SERVER DID NOT START"; return 2; }
  python3 scripts/verify-camera-episode.py >"/tmp/mut-verify-$n.log" 2>&1
  local rc=$?
  tmux kill-session -t mut 2>/dev/null
  return $rc
}

mutant() { # name, file, old|||new
  n=$((n+1))
  restore
  python3 - "$2" "$3" <<'PY'
import sys
path, expr = sys.argv[1], sys.argv[2]
s = open(path).read()
old, new = expr.split("|||")
if old not in s:
    print("PATCH-MISS"); sys.exit(3)
open(path, "w").write(s.replace(old, new, 1))
PY
  if [ $? -eq 3 ]; then echo "  [$n] $1 -> PATCH DID NOT APPLY (mutant invalid)"; survived=$((survived+1)); return; fi
  rebuild_and_run
  case $? in
    0) echo "  [$n] $1 -> SURVIVED  <-- the browser check passes against a broken build"
       survived=$((survived+1)) ;;
    2) echo "  [$n] $1 -> BUILD FAILED (mutant invalid)"; survived=$((survived+1)) ;;
    *) echo "  [$n] $1 -> killed ($(grep -c '^  \[FAIL\]' "/tmp/mut-verify-$n.log") checks failed)"
       killed=$((killed+1)) ;;
  esac
}

echo "mutating the fix and re-running the browser check"

mutant "the original bug: a row for every detection" "$SRC" \
  'const record = !ep.lost || escalation;|||const record = true;'

mutant "the shipped leak: unlocking counts as the camera being fixed" "$RUN" \
  '      // NOTE: the camera episode is deliberately NOT reset here.|||      camEpisodeRef.current = freshEpisode();
      // NOTE: the camera episode is deliberately NOT reset here.'

restore
echo
echo "killed=$killed survived=$survived of $n"
[ "$survived" -eq 0 ] || exit 1
