#!/usr/bin/env bash
# Bump the release tag references throughout the repo.
#
# Usage:
#   scripts/bump-version.sh <new-version>
#   Example: scripts/bump-version.sh v0.5.8
#
# Updates README.md, install.sh, and install.ps1 to point at the new
# release tag. Does NOT create the git tag, commit, or push — review
# the diff, commit manually, then tag + push.

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

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# Files that embed the release tag in install URLs or script variables.
# These should all agree on the current release, so we replace every
# `vX.Y.Z` token in each file rather than matching a specific old version.
FILES=(
  "README.md"
  "install.sh"
  "install.ps1"
)

changed=0
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "  skipping missing $f"
    continue
  fi
  before=$(grep -Eo 'v[0-9]+\.[0-9]+\.[0-9]+' "$f" | sort -u | tr '\n' ' ' || true)
  # sed -i.bak then delete the backup — works on both BSD and GNU sed.
  sed -i.bak -E "s|v[0-9]+\.[0-9]+\.[0-9]+|$NEW|g" "$f"
  rm -f "$f.bak"
  after=$(grep -Eo 'v[0-9]+\.[0-9]+\.[0-9]+' "$f" | sort -u | tr '\n' ' ' || true)
  if [ "$before" != "$after" ]; then
    echo "  $f: [$before] → [$after]"
    changed=$((changed + 1))
  fi
done

if [ "$changed" -eq 0 ]; then
  echo "no changes — all files already on $NEW."
  exit 0
fi

cat <<EOF

Bumped $changed file(s) to $NEW.

Next steps:
  git diff
  git commit -am "Bump version references to $NEW"
  git tag $NEW
  git push && git push --tags
EOF
