#!/usr/bin/env bash
# Cut a release: bump version references, commit, tag, push.
# CI (.github/workflows/release.yml) takes it from there — Docker build
# + push to GHCR, GitHub Release with auto-generated notes.
#
# Usage:
#   scripts/release-version.sh <new-version>
#   Example: scripts/release-version.sh v0.5.8

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <new-version>  (e.g. v0.5.8)" >&2
  exit 1
fi

NEW="$1"
case "$NEW" in
  v*) ;;
  *) NEW="v$NEW" ;;
esac

if ! printf '%s' "$NEW" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: expected vMAJOR.MINOR.PATCH, got $NEW" >&2
  exit 1
fi
NEW_NO_V="${NEW#v}"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# Safety checks so a release never leaves the repo in a half-done state.

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree has uncommitted changes. Commit or stash first." >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "error: must be on 'main' to cut a release (currently '$CURRENT_BRANCH')" >&2
  exit 1
fi

echo "==> fetching origin/main"
git fetch origin main >/dev/null
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "error: local main is not in sync with origin/main. Pull first." >&2
  exit 1
fi

if git rev-parse "$NEW" >/dev/null 2>&1; then
  echo "error: tag $NEW already exists locally." >&2
  exit 1
fi
if git ls-remote --tags origin | grep -q "refs/tags/$NEW$"; then
  echo "error: tag $NEW already exists on origin." >&2
  exit 1
fi

# Bump README / install.sh / install.ps1.
echo "==> bumping install and doc references"
"$ROOT/scripts/bump-version.sh" "$NEW"

# Bump workspace package.json versions via Node (cross-platform-safe,
# preserves JSON structure).
PACKAGES=(
  "package.json"
  "server/package.json"
  "web/package.json"
  "shared/package.json"
)
echo "==> bumping package.json versions"
for p in "${PACKAGES[@]}"; do
  if [ ! -f "$p" ]; then continue; fi
  node -e '
    const fs = require("fs");
    const [path, version] = [process.argv[1], process.argv[2]];
    const j = JSON.parse(fs.readFileSync(path, "utf8"));
    if (j.version === version) { process.exit(0); }
    j.version = version;
    fs.writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
    console.log(`  ${path}: → ${version}`);
  ' "$p" "$NEW_NO_V"
done

echo
echo "==> diff summary"
git --no-pager diff --stat

if [ -z "$(git status --porcelain)" ]; then
  echo "no changes — already on $NEW?"
  exit 0
fi

echo
echo "==> committing, tagging, pushing"
git commit -am "Release $NEW"
git tag -a "$NEW" -m "Release $NEW"
git push origin main "$NEW"

cat <<EOF

✓ Released $NEW.

CI is now running. Watch progress with:
  gh run watch

When it finishes:
  - Docker image: ghcr.io/rsteckler/applaud:$NEW (and :latest)
  - GitHub Release: https://github.com/rsteckler/applaud/releases/tag/$NEW
EOF
