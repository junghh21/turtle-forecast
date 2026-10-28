#!/bin/bash
set -u
D=/home/aaa/snp-advisor
MODE=${1:-run}
exec 9>"$D/.lock"
flock -w 1500 9 || { echo "$(date -u +%FT%TZ) $MODE lock busy" >> "$D/run.log"; exit 0; }

SKIP=0
if [ "$MODE" != report ]; then
  for i in $(seq 1 20); do
    LOG=/var/lib/docker/volumes/advisor-data/_data/logs/debug-$(date -u +%F).jsonl
    last=$(grep -E '"event":"(ask:|probe:selector)' "$LOG" 2>/dev/null | tail -1 | cut -c8-31)
    [ -z "$last" ] && break
    idle=$(( $(date +%s) - $(date -d "$last" +%s) ))
    [ "$idle" -ge 180 ] && break
    [ "$i" -eq 20 ] && SKIP=1
    sleep 60
  done
fi

SEC=$(docker exec advisor-mcp printenv ADVISOR_SECRET)
IMG=$(docker inspect -f '{{.Config.Image}}' advisor-mcp)

runner() {
  timeout 1200 docker run --rm --name "snp-$MODE-$$" --shm-size=512m \
    -v "$D:/snp" -v "$D/snp.mjs:/app/snp.mjs:ro" \
    -e SNP_DIR=/snp -e ADVISOR_SECRET="$SEC" -e SNP_SKIP_ASK=$SKIP \
    --entrypoint node -w /app "$IMG" snp.mjs "$MODE" >> "$D/run.log" 2>&1
}

sandbox() {
  timeout 120 docker run --rm --name "snp-sbx-$$" --network none --read-only --tmpfs /tmp:size=16m \
    --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 512m --cpus 1 -u 1001:1001 \
    -v "$D/work/sbx:/sbx:ro" --entrypoint node node:22-alpine /sbx/harness.mjs > "$D/work/sbx_out.tmp" 2>> "$D/run.log"
  local rc=$?
  mv "$D/work/sbx_out.tmp" "$D/work/sbx_out.json"
  echo "$(date -u +%FT%TZ) sandbox rc=$rc bytes=$(stat -c %s "$D/work/sbx_out.json")" >> "$D/run.log"
  chown 1001:1001 "$D/work/sbx_out.json"
}

echo "$(date -u +%FT%TZ) start $MODE skip_ask=$SKIP" >> "$D/run.log"
runner; rc=$?
n=0
while [ "$rc" -eq 10 ] && [ "$n" -lt 6 ]; do
  sandbox
  runner; rc=$?
  n=$((n + 1))
done
echo "$(date -u +%FT%TZ) end $MODE rc=$rc sandbox_rounds=$n" >> "$D/run.log"

cd "$D/site" || exit 0
G="git -c safe.directory=* -c user.name=turtle-bot -c user.email=turtle-bot@users.noreply.github.com"
$G fetch -q origin main && $G reset -q --mixed origin/main \
  && $G checkout -q origin/main -- $($G ls-tree --name-only origin/main | grep -v '^data$')
$G add -A data
if ! $G diff --cached --quiet; then
  if $G log -1 --format=%s | grep -q '^data '; then $G commit -q --amend -m "data $(date -u +%FT%TZ)"; else $G commit -q -m "data $(date -u +%FT%TZ)"; fi
  T=$(docker exec advisor-mcp printenv ADVISOR_GH_TOKEN)
  $G -c http.extraheader="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$T" | base64 -w0)" push -q --force-with-lease=main:origin/main origin HEAD:main >> "$D/run.log" 2>&1 \
    && echo "$(date -u +%FT%TZ) published" >> "$D/run.log"
fi
chown -R 1001:1001 "$D"
