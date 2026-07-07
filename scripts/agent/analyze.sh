#!/usr/bin/env bash
# =============================================================
#  NOVA Code Analysis Tool
#  Analyzes codebase for issues, dead code, complexity
# =============================================================
set -euo pipefail

PROJECT_DIR="${1:-$(pwd)}"
cd "$PROJECT_DIR"

echo "=== NOVA Code Analysis ==="
echo ""

# 1. TypeScript strict errors count
echo "📊 TypeScript Errors:"
tsc --noEmit 2>&1 | tail -1 || echo "  (checking...)"
echo ""

# 2. ESLint issues
echo "📊 ESLint Issues:"
pnpm lint:eslint 2>&1 | tail -5 || echo "  (checking...)"
echo ""

# 3. Test status
echo "📊 Test Status:"
pnpm test 2>&1 | tail -3 || echo "  (checking...)"
echo ""

# 4. Dependency health
echo "📦 Dependency Audit:"
pnpm audit:final 2>&1 | head -20 || echo "  (checking...)"
echo ""

# 5. Coverage
echo "📈 Coverage:"
if [ -f "coverage/coverage-final.json" ]; then
  python3 -c "
import json
d = json.load(open('coverage/coverage-final.json'))
total = len(d)
covered = sum(1 for v in d.values() if v.get('covered', 0) > 0)
print(f'  Files: {total}')
print(f'  Files with coverage: {covered}')
" 2>/dev/null || echo "  (coverage report not found)"
else
  echo "  (run pnpm test:coverage to generate)"
fi
echo ""

# 6. Dead code indicators (console.log in src)
echo "🗑️ Console.log in src/:"
grep -rn "console\.log" src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "test" | grep -v "spec" | head -10 || echo "  None found"
echo ""

# 7. Any type usage
echo "⚠️  Any type usage:"
grep -rn "as any" src/ --include="*.ts" --include="*.tsx" 2>/dev/null | head -10 || echo "  None found"
echo ""

# 8. FIXME/TODO/HACK
echo "🔍 FIXME/TODO/HACK count:"
FIXME=$(grep -rn "FIXME\|TODO\|HACK\|XXX" src/ --include="*.ts" --include="*.tsx" 2>/dev/null | wc -l)
echo "  $FIXME occurrences"
echo ""

# 9. Bundle size estimate
echo "📦 Bundle Size:"
if [ -d "dist" ]; then
  du -sh dist/ 2>/dev/null || echo "  (dist not found)"
  find dist/ -name "*.js" -exec du -sh {} \; 2>/dev/null | sort -rh | head -5
else
  echo "  (run pnpm build to check)"
fi
echo ""

# 10. Dependency count
echo "📋 Dependency Count:"
python3 -c "
import json
d = json.load(open('package.json'))
deps = len(d.get('dependencies', {}))
devDeps = len(d.get('devDependencies', {}))
print(f'  Dependencies: {deps}')
print(f'  Dev Dependencies: {devDeps}')
print(f'  Total: {deps + devDeps}')
" 2>/dev/null || echo "  (error reading package.json)"
echo ""

echo "=== Analysis Complete ==="
