#!/usr/bin/env bash
# Upserts panote's Cache Rules (cache-rules.<env>.json) into a zone's
# http_request_cache_settings entrypoint ruleset. The PUT replaces the whole
# phase, so this reads the live ruleset first, keeps every rule it doesn't
# manage (e.g. tiles-404-short-ttl) exactly as it is, replaces or appends each
# managed rule by its `ref`, and shows the diff. Nothing is written without
# --yes. See docs/deploy.md, "CDN cache rules".
#
#   CF_API_TOKEN=... infra/cloudflare/apply-cache-rules.sh dev [--dry-run | --yes]
#   infra/cloudflare/apply-cache-rules.sh dev --dry-run --live-file saved.json
#
# The token needs Zone -> Cache Rules: Edit on the zone (Read is enough for
# --dry-run). --live-file diffs against a saved GET response instead of the API.
set -euo pipefail

API=https://api.cloudflare.com/client/v4
PHASE=http_request_cache_settings

die() {
  echo "apply-cache-rules: $*" >&2
  exit 1
}
usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

env_name=""
mode=show
live_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      [ "$mode" != apply ] || die "--dry-run and --yes together; pick one"
      mode=dry-run
      ;;
    --yes)
      [ "$mode" != dry-run ] || die "--dry-run and --yes together; pick one"
      mode=apply
      ;;
    --live-file)
      [ $# -ge 2 ] || die "--live-file needs a path"
      live_file=$2
      shift
      ;;
    -h | --help) usage 0 ;;
    -*) die "unknown flag $1" ;;
    *)
      [ -z "$env_name" ] || die "one env only"
      env_name=$1
      ;;
  esac
  shift
done
[ -n "$env_name" ] || usage 1
[ "$mode" != apply ] || [ -z "$live_file" ] || die "--yes always reads the live ruleset; drop --live-file"
command -v jq >/dev/null || die "needs jq"

dir=$(cd "$(dirname "$0")" && pwd)
config="$dir/cache-rules.$env_name.json"
[ -f "$config" ] || die "no $config"
zone_id=$(jq -er '.zoneId' "$config")
zone=$(jq -er '.zone' "$config")
managed=$(jq -ce '.rules' "$config")
jq -e 'all(.[]; (.ref | type) == "string" and (.ref | length) > 0)' <<<"$managed" >/dev/null ||
  die "every managed rule needs a ref"
jq -e '(map(.ref) | unique | length) == length' <<<"$managed" >/dev/null || die "duplicate refs"
entrypoint="$API/zones/$zone_id/rulesets/phases/$PHASE/entrypoint"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cf() { # cf <method> <url> [body-file]; writes the body to $tmp/out, prints the status
  local args=(-sS -o "$tmp/out" -w '%{http_code}' -X "$1" "$2" -H "Authorization: Bearer $CF_API_TOKEN")
  [ $# -lt 3 ] || args+=(-H 'Content-Type: application/json' --data-binary "@$3")
  curl "${args[@]}"
}

# 1. The live ruleset. A zone that never had a cache rule has no entrypoint (404).
if [ -n "$live_file" ]; then
  jq -e '.result // .' "$live_file" >"$tmp/live.json" || die "can't read $live_file"
else
  [ -n "${CF_API_TOKEN:-}" ] || die "set CF_API_TOKEN (Zone -> Cache Rules: Edit on $zone)"
  status=$(cf GET "$entrypoint")
  case "$status" in
    200) jq -e '.result' "$tmp/out" >"$tmp/live.json" ;;
    404) echo '{"rules":[]}' >"$tmp/live.json" ;;
    *) die "GET entrypoint: HTTP $status: $(jq -c '.errors // .' "$tmp/out" 2>/dev/null || cat "$tmp/out")" ;;
  esac
fi

# 2. Live rules minus read-only fields, managed rules upserted by ref. A replaced
#    rule keeps its id and position; a new one goes last.
jq --argjson managed "$managed" '
  [(.rules // [])[] | del(.version, .last_updated, .categories)] as $live
  | reduce $managed[] as $m ($live;
      if any(.[]; .ref == $m.ref)
      then map(if .ref == $m.ref then ({id} | with_entries(select(.value != null))) + $m else . end)
      else . + [$m]
      end)
' "$tmp/live.json" >"$tmp/desired.json"
jq '[(.rules // [])[] | del(.version, .last_updated, .categories)]' "$tmp/live.json" >"$tmp/current.json"

# 3. The diff, on what the rules do (ids aside).
jq -S 'map(del(.id))' "$tmp/current.json" >"$tmp/a.json"
jq -S 'map(del(.id))' "$tmp/desired.json" >"$tmp/b.json"
echo "zone $zone ($zone_id), phase $PHASE"
echo "keeping: $(jq -r --argjson m "$managed" '[.[] | select(.ref as $r | $m | map(.ref) | index($r) | not) | .description // .ref] | join(", ") | if . == "" then "(none)" else . end' "$tmp/current.json")"
if diff -u --label "live" --label "after" "$tmp/a.json" "$tmp/b.json"; then
  echo "No changes: the live ruleset already matches $config."
  exit 0
fi

case "$mode" in
  dry-run)
    echo "Dry run: nothing written."
    exit 0
    ;;
  show)
    echo "Not applied. Re-run with --yes to PUT this ruleset."
    exit 0
    ;;
esac

# 4. Re-read right before writing: if anyone changed the rules since the diff above, the
#    PUT would silently drop their change, so stop and let the diff be looked at again.
status=$(cf GET "$entrypoint")
case "$status" in
  200) jq -e '.result' "$tmp/out" >"$tmp/again.json" ;;
  404) echo '{"rules":[]}' >"$tmp/again.json" ;;
  *) die "re-GET entrypoint: HTTP $status" ;;
esac
jq -S '[(.rules // [])[] | del(.version, .last_updated, .categories)]' "$tmp/again.json" >"$tmp/again-rules.json"
jq -S '.' "$tmp/current.json" >"$tmp/current-sorted.json"
cmp -s "$tmp/current-sorted.json" "$tmp/again-rules.json" ||
  die "the live rules changed since the diff; nothing written. Run it again."

# 5. PUT the whole phase, then show what Cloudflare now has.
jq '{rules: .}' "$tmp/desired.json" >"$tmp/body.json"
status=$(cf PUT "$entrypoint" "$tmp/body.json")
[ "$status" = 200 ] || die "PUT entrypoint: HTTP $status: $(jq -c '.errors // .' "$tmp/out" 2>/dev/null || cat "$tmp/out")"
echo "Applied. Live rules now:"
jq -r '.result.rules[] | "  \(.ref)  \(.description)  enabled=\(.enabled)"' "$tmp/out"
