import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const roots = [
  path.join(repoRoot, "desktop-native", "qml"),
  path.join(repoRoot, "desktop-native", "src", "localization", "I18nManager.cpp"),
];

const banned = [
  { pattern: /yt-dlp/gi, label: "yt-dlp" },
  { pattern: /ffmpeg/gi, label: "FFmpeg" },
  { pattern: /rust[ -]daemon/gi, label: "Rust daemon" },
  { pattern: /rust-engine/gi, label: "Rust engine" },
];

function filesUnder(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];

  const files = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else if (entry.isFile() && (entry.name.endsWith(".qml") || entry.name.endsWith(".cpp"))) {
      files.push(full);
    }
  }
  return files;
}

const violations = [];
for (const root of roots) {
  for (const file of filesUnder(root)) {
    const source = fs.readFileSync(file, "utf8");
    for (const rule of banned) {
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(source)) !== null) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push({
          file: path.relative(repoRoot, file).replaceAll("\\", "/"),
          line,
          label: rule.label,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("External implementation branding found in user-facing native UI copy:");
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} contains ${violation.label}`);
  }
  console.error("Use NOVA Engine / NOVA Media Engine terminology in user-facing copy.");
  process.exit(1);
}

console.log("Native product-copy branding gate passed.");
