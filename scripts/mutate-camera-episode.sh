#!/usr/bin/env bash
# Mutation test for camera-episode.ts. A test suite that passes against broken
# source is decoration. Each mutant below is a plausible way to get this wrong;
# every one must make at least one test fail.
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=src/web/student/lib/camera-episode.ts
BAK=$(mktemp)
cp "$SRC" "$BAK"
restore() { cp "$BAK" "$SRC"; }
trap 'restore; rm -f "$BAK"' EXIT

killed=0; survived=0; n=0

mutant() { # name, python replace expression
  n=$((n+1))
  restore
  python3 - "$SRC" "$2" <<'PY'
import sys, re
path, expr = sys.argv[1], sys.argv[2]
s = open(path).read()
old, new = expr.split("|||")
if old not in s:
    print("PATCH-MISS"); sys.exit(3)
open(path, "w").write(s.replace(old, new, 1))
PY
  if [ $? -eq 3 ]; then echo "  [$n] $1 -> PATCH DID NOT APPLY (mutant invalid)"; survived=$((survived+1)); return; fi
  if bun test src/web/student/lib/camera-episode.test.ts >/tmp/mut.log 2>&1; then
    echo "  [$n] $1 -> SURVIVED  <-- tests do not cover this"
    survived=$((survived+1))
  else
    echo "  [$n] $1 -> killed ($(grep -cE '^\(fail\)' /tmp/mut.log) failing)"
    killed=$((killed+1))
  fi
}

echo "mutating $SRC"

mutant "record every detection (no episode suppression)" \
  'const record = !ep.lost || escalation;|||const record = true;'

mutant "drop the camera_lost -> camera_blocked escalation" \
  'const record = !ep.lost || escalation;|||const record = !ep.lost;'

mutant "allow re-escalation / de-escalation both ways" \
  'const escalation = ep.lost && ep.recorded === "camera_lost" && type === "camera_blocked";|||const escalation = ep.lost && ep.recorded !== type;'

mutant "end the episode on a single live observation" \
  'if (ep.liveSince === null) return { ...ep, liveSince: now };|||if (ep.liveSince === null) return freshEpisode();'

mutant "off-by-one on the clear window (> instead of >=)" \
  'if (now - ep.liveSince >= EPISODE_CLEAR_MS) return freshEpisode();|||if (now - ep.liveSince > EPISODE_CLEAR_MS) return freshEpisode();'

mutant "keep the live run across a fresh loss" \
  'episode: { lost: true, recorded: record ? type : ep.recorded, liveSince: null },|||episode: { lost: true, recorded: record ? type : ep.recorded, liveSince: ep.liveSince },'

mutant "a dead observation no longer voids the live run" \
  'if (!live) return ep.liveSince === null ? ep : { ...ep, liveSince: null };|||if (!live) return ep;'

# A short window is the same bug as clearing on a single reading: the recovery poll
# re-opens the device every 2.5s, so anything under it clears on a flap.
mutant "clear window short enough for a flap to clear it" \
  'export const EPISODE_CLEAR_MS = 10_000;|||export const EPISODE_CLEAR_MS = 1_000;'

restore
echo
echo "killed=$killed survived=$survived of $n"
if bun test src/web/student/lib/camera-episode.test.ts >/dev/null 2>&1; then
  echo "source restored, suite green"
else
  echo "SOURCE NOT RESTORED CLEANLY"; exit 1
fi
[ "$survived" -eq 0 ] || exit 1
