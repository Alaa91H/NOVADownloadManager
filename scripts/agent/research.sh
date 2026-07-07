#!/usr/bin/env bash
# =============================================================
#  NOVA Research Tool — npm / crates.io / GitHub / changelog
#  Usage:
#    research.sh npm <package>        — info about npm package
#    research.sh npm-vers <package>   — latest 10 versions
#    research.sh crate <name>         — info about Rust crate
#    research.sh changelog <url>      — fetch CHANGELOG.md
#    research.sh compare <pkg1> <pkg2> — compare two npm packages
# =============================================================
set -euo pipefail

research_npm() {
  local pkg="$1"
  curl -s "https://registry.npmjs.org/$pkg" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    v = d.get('dist-tags', {}).get('latest', 'unknown')
    desc = d.get('description', '')
    deps = len(d.get('versions', {}).get(v, {}).get('dependencies', {}))
    downloads = 'N/A'
    print(f'Package: {d.get(\"name\", \"\")}')
    print(f'Latest:  {v}')
    print(f'Description: {desc}')
    print(f'Dependencies: {deps}')
except: print('Error parsing')
" 2>/dev/null
  # Get download count
  curl -s "https://api.npmjs.org/downloads/point/last-week/$pkg" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(f'Weekly downloads: {d.get(\"downloads\", \"N/A\")}')
except: pass
" 2>/dev/null
}

research_npm_versions() {
  local pkg="$1"
  curl -s "https://registry.npmjs.org/$pkg" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    versions = list(d.get('versions', {}).keys())
    for v in versions[-10:]:
        print(v)
except: print('Error')
" 2>/dev/null
}

research_crate() {
  local name="$1"
  curl -s "https://crates.io/api/v1/crates/$name" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    c = d.get('crate', {})
    print(f'Crate: {c.get(\"name\", \"\")}')
    print(f'Latest: {c.get(\"max_version\", \"\")}')
    print(f'Description: {c.get(\"description\", \"\")}')
    print(f'Downloads: {c.get(\"downloads\", 0)}')
    print(f'License: {c.get(\"license\", \"\")}')
    print(f'Homepage: {c.get(\"homepage\", \"\")}')
    print(f'Documentation: {c.get(\"documentation\", \"\")}')
except: print('Error')
" 2>/dev/null
}

research_changelog() {
  local url="$1"
  # Try common CHANGELOG paths
  for path in CHANGELOG.md CHANGELOG CHANGELOG.txt changelog.md HISTORY.md; do
    local full_url="${url%/}/$path"
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" "$full_url" 2>/dev/null || echo "000")
    if [ "$status" = "200" ]; then
      echo "=== $path ==="
      curl -sL "$full_url" 2>/dev/null | head -100
      return 0
    fi
  done

  # Try GitHub releases
  if echo "$url" | grep -q "github.com"; then
    local repo
    repo=$(echo "$url" | sed 's|https://github.com/||; s|/tree/.*||; s|/blob/.*||')
    echo "=== GitHub Releases for $repo ==="
    curl -s "https://api.github.com/repos/$repo/releases?per_page=5" | python3 -c "
import sys, json
try:
    releases = json.load(sys.stdin)
    for r in releases[:5]:
        print(f'{r.get(\"tag_name\", \"\")} — {r.get(\"name\", \"\")} — {r.get(\"published_at\", \"\")[:10]}')
except: print('No releases found')
" 2>/dev/null
  fi
}

research_compare() {
  local pkg1="$1"
  local pkg2="$2"
  echo "=== Comparing $pkg1 vs $pkg2 ==="
  echo ""
  echo "--- $pkg1 ---"
  research_npm "$pkg1"
  echo ""
  echo "--- $pkg2 ---"
  research_npm "$pkg2"
  echo ""
  echo "--- Comparison ---"
  curl -s "https://registry.npmjs.org/$pkg1" | python3 -c "
import sys, json
d1 = json.load(sys.stdin)
v1 = d1.get('dist-tags', {}).get('latest', '?')
" 2>/dev/null
  curl -s "https://registry.npmjs.org/$pkg2" | python3 -c "
import sys, json
d2 = json.load(sys.stdin)
v2 = d2.get('dist-tags', {}).get('latest', '?')
" 2>/dev/null
  python3 -c "
import json, urllib.request
try:
    d1 = json.loads(urllib.request.urlopen('https://registry.npmjs.org/$pkg1').read())
    d2 = json.loads(urllib.request.urlopen('https://registry.npmjs.org/$pkg2').read())
    v1 = d1.get('dist-tags', {}).get('latest', '?')
    v2 = d2.get('dist-tags', {}).get('latest', '?')
    dl1 = 'N/A'
    dl2 = 'N/A'
    try:
        dl1 = json.loads(urllib.request.urlopen('https://api.npmjs.org/downloads/point/last-week/$pkg1').read()).get('downloads', 'N/A')
    except: pass
    try:
        dl2 = json.loads(urllib.request.urlopen('https://api.npmjs.org/downloads/point/last-week/$pkg2').read()).get('downloads', 'N/A')
    except: pass
    desc1 = d1.get('description', '')[:80]
    desc2 = d2.get('description', '')[:80]
    print(f'{\"Attribute\":<20} {\"$pkg1\":<30} {\"$pkg2\":<30}')
    print(f'{\"-\"*20} {\"-\"*30} {\"-\"*30}')
    print(f'{\"Version\":<20} {v1:<30} {v2:<30}')
    print(f'{\"Weekly DL\":<20} {str(dl1):<30} {str(dl2):<30}')
    print(f'{\"Description\":<20} {desc1:<30} {desc2:<30}')
" 2>/dev/null
}

# Main
case "${1:-help}" in
  npm) research_npm "$2" ;;
  npm-vers) research_npm_versions "$2" ;;
  crate) research_crate "$2" ;;
  changelog) research_changelog "$2" ;;
  compare) research_compare "$2" "$3" ;;
  help|*)
    echo "NOVA Research Tool"
    echo "Usage:"
    echo "  research.sh npm <package>"
    echo "  research.sh npm-vers <package>"
    echo "  research.sh crate <name>"
    echo "  research.sh changelog <url>"
    echo "  research.sh compare <pkg1> <pkg2>"
    ;;
esac
