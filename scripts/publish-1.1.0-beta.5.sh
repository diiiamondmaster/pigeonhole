#!/bin/bash
# publish-1.1.0-beta.5.sh - publishes the beta branch as a PRE-RELEASE.
# Channels stay side by side:
#   stable = v1.0.6 (the regular release; /releases/latest keeps pointing at it)
#   beta   = v1.1.0-beta.5 (this prerelease; found via the releases list)
# Usage: GH_TOKEN=ghp_... bash publish-1.1.0-beta.5.sh
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN env var required}"
DIR="/home/z/my-project/pigeonhole"
OWNER=diiiamondmaster
REPO=pigeonhole
API="https://api.github.com"
AUTH="Authorization: Bearer $GH_TOKEN"
NOTES="/home/z/my-project/pigeonhole/scripts/release-notes-v1.1.0-beta.5.md"
ASSET="/home/z/my-project/download/Pigeonhole-1.1.0-beta.5-win-x64.zip"
TAG="v1.1.0-beta.5"
SUPERSEDED="v1.1.0-beta.4"

[ -f "$ASSET" ] || { echo "asset missing: $ASSET"; exit 1; }
[ -d "$DIR" ] || { echo "worktree missing: $DIR"; exit 1; }
git -C "$DIR" rev-parse --abbrev-ref HEAD | grep -qx beta || { echo "worktree is not on the beta branch"; exit 1; }

echo "== token"
curl -sf -H "$AUTH" "$API/user" | python3 -c 'import json,sys;print("authenticated as", json.load(sys.stdin)["login"])'

echo "== commit release state"
git -C "$DIR" add -A
git -C "$DIR" diff --cached --quiet || git -C "$DIR" commit -q -m "chore: release v1.1.0-beta.5 state"
git -C "$DIR" tag -f "$TAG" >/dev/null 2>&1 || true

echo "== push beta branch + tag $TAG"
GIT_AUTH="http.extraheader=Authorization: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
git -C "$DIR" -c "$GIT_AUTH" push https://github.com/$OWNER/$REPO.git beta:beta
git -C "$DIR" -c "$GIT_AUTH" push https://github.com/$OWNER/$REPO.git "refs/tags/$TAG:refs/tags/$TAG"

echo "== replace any earlier $TAG release, keep stable v1.0.6 live"
OLD_ID=$(curl -sf -H "$AUTH" "$API/repos/$OWNER/$REPO/releases/tags/$TAG" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])' 2>/dev/null || true)
if [ -n "${OLD_ID:-}" ]; then
  curl -sf -X DELETE -H "$AUTH" "$API/repos/$OWNER/$REPO/releases/$OLD_ID" && echo "deleted stale release $OLD_ID"
fi

# exactly ONE beta stays live: the superseded beta.4 release + its tag go
OLD_B4_ID=$(curl -sf -H "$AUTH" "$API/repos/$OWNER/$REPO/releases/tags/$SUPERSEDED" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])' 2>/dev/null || true)
if [ -n "${OLD_B4_ID:-}" ] && [ "$OLD_B4_ID" != "$OLD_ID" ]; then
  curl -sf -X DELETE -H "$AUTH" "$API/repos/$OWNER/$REPO/releases/$OLD_B4_ID" && echo "deleted superseded release $SUPERSEDED (id $OLD_B4_ID)"
  git -C "$DIR" -c "http.extraheader=Authorization: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)" \
    push https://github.com/$OWNER/$REPO.git ":refs/tags/$SUPERSEDED" && echo "deleted remote tag $SUPERSEDED"
fi

echo "== create PRE-RELEASE $TAG"
RELEASE_JSON=$(python3 - "$NOTES" "$TAG" <<'EOF'
import json, sys
notes = open(sys.argv[1], encoding='utf-8').read()
print(json.dumps({"tag_name": sys.argv[2], "name": sys.argv[2], "body": notes,
                  "target_commitish": "beta", "draft": False, "prerelease": True}))
EOF
)
RELEASE_ID=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" -d "$RELEASE_JSON" \
  "$API/repos/$OWNER/$REPO/releases" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])' \
  2>/dev/null || curl -sf -H "$AUTH" "$API/repos/$OWNER/$REPO/releases/tags/$TAG" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
echo "release id: $RELEASE_ID"

echo "== upload asset"
curl -sf -X POST -H "$AUTH" -H "Content-Type: application/zip" --data-binary "@$ASSET" \
  "https://uploads.github.com/repos/$OWNER/$REPO/releases/$RELEASE_ID/assets?name=Pigeonhole-1.1.0-beta.5-win-x64.zip" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print("uploaded:", d.get("name"), d.get("size"), "bytes")'

echo "== verify both channels (authenticated)"
sleep 2
curl -sf -H "$AUTH" "$API/repos/$OWNER/$REPO/releases/latest" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("STABLE /releases/latest:", d["tag_name"], "| prerelease:", d["prerelease"], "| assets:", [(a["name"], a["size"]) for a in d["assets"]])'
curl -sf -H "$AUTH" "$API/repos/$OWNER/$REPO/releases?per_page=5" | python3 -c 'import json,sys;[print("LIST[%d]:" % i, r["tag_name"], "| prerelease:", r["prerelease"]) for i, r in enumerate(json.load(sys.stdin))]'
curl -sf -H "$AUTH" "$API/repos/$OWNER/$REPO/branches" | python3 -c 'import json,sys;[print("branch:", b["name"], b["commit"]["sha"][:8]) for b in json.load(sys.stdin)]'
echo "== done"
