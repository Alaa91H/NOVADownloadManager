#!/usr/bin/env bash
# NOVA static analysis helper for an orchestrator-only server.
# It intentionally does not run local build/test/lint tools. CI is the source of
# truth for TypeScript, ESLint, tests, builds, packaging, and coverage.
set -euo pipefail

PROJECT_DIR="${1:-${NOVA_PROJECT_DIR:-$(pwd)}}"
BRANCH="${NOVA_BRANCH:-${NOVA_DEVELOP_BRANCH:-develop}}"
GH_REPO="${NOVA_GH_REPO:-}"
cd "$PROJECT_DIR"

echo "=== NOVA Static Project Analysis ==="
echo "Project: $PROJECT_DIR"
echo "Branch:  $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
echo "Head:    $(git log -1 --pretty='%h %s' 2>/dev/null || echo unknown)"
echo ""

echo "== CI status (GitHub Actions) =="
if command -v gh >/dev/null 2>&1 && [[ -n "$GH_REPO" ]]; then
  gh run list --repo "$GH_REPO" --branch "$BRANCH" --limit 8 \
    --json databaseId,status,conclusion,name,createdAt,headSha \
    --jq '.[] | "\(.createdAt[:19]) | \(.status) | \(.conclusion // "-") | \(.name) | \(.headSha[:7]) | #\(.databaseId)"' \
    2>/dev/null || echo "  (gh run list failed; check gh auth/repo)"
else
  echo "  (gh unavailable or NOVA_GH_REPO not configured)"
fi
echo ""

echo "== Repository state =="
git status --short 2>/dev/null || true
echo ""

echo "== Source inventory =="
printf 'TypeScript files: '; find . -path ./.git -prune -o -path ./node_modules -prune -o -type f \( -name '*.ts' -o -name '*.tsx' \) -print 2>/dev/null | wc -l
printf 'Rust files:       '; find . -path ./.git -prune -o -path ./target -prune -o -type f -name '*.rs' -print 2>/dev/null | wc -l
printf 'Docs files:       '; find . -path ./.git -prune -o -type f \( -name '*.md' -o -name '*.mdx' \) -print 2>/dev/null | wc -l
echo ""

echo "== Risk indicators (static grep only) =="
printf 'console.log in src: '; grep -RIn --include='*.ts' --include='*.tsx' 'console\.log' src 2>/dev/null | grep -vcE '(test|spec)' || true
printf 'as any in src:      '; grep -RIn --include='*.ts' --include='*.tsx' 'as any' src 2>/dev/null | wc -l | tr -d ' '
printf 'TODO/FIXME/HACK:    '; grep -RIn --include='*.ts' --include='*.tsx' --include='*.rs' -E 'TODO|FIXME|HACK|XXX' src src-tauri 2>/dev/null | wc -l | tr -d ' '
echo ""

echo "Top TODO/FIXME/HACK examples:"
grep -RIn --include='*.ts' --include='*.tsx' --include='*.rs' -E 'TODO|FIXME|HACK|XXX' src src-tauri 2>/dev/null | head -20 || echo "  None found"
echo ""

echo "== Large generated/cache directories =="
for d in dist build coverage node_modules src-tauri/target .next .vite; do
  [[ -e "$d" ]] && du -sh "$d" 2>/dev/null || true
done

echo ""
echo "=== Analysis Complete ==="
