import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const qmlRoot = path.join(repoRoot, "desktop-native", "qml");
const catalogPath = path.join(
  repoRoot,
  "desktop-native",
  "src",
  "localization",
  "I18nManager.cpp"
);

const banned = [
  { pattern: /yt-dlp/i, label: "yt-dlp" },
  { pattern: /ffmpeg/i, label: "FFmpeg" },
  { pattern: /rust[ -]daemon/i, label: "Rust daemon" },
  { pattern: /rust-engine/i, label: "Rust engine" },
];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".qml")) files.push(full);
  }
  return files;
}

function checkValue(file, line, value, violations) {
  for (const rule of banned) {
    if (rule.pattern.test(value)) {
      violations.push({ file, line, label: rule.label, value });
    }
  }
}

const violations = [];
const qmlPropertyPattern =
  /\b(text|placeholderText|title|Accessible\.name|Accessible\.description)\s*:\s*"([^"\n]*)"/g;

for (const file of walk(qmlRoot)) {
  const source = fs.readFileSync(file, "utf8");
  let match;
  while ((match = qmlPropertyPattern.exec(source)) !== null) {
    const line = source.slice(0, match.index).split("\n").length;
    checkValue(
      path.relative(repoRoot, file).replaceAll("\\", "/"),
      line,
      match[2],
      violations
    );
  }
}

const catalog = fs.readFileSync(catalogPath, "utf8");
const catalogValuePattern =
  /\{QStringLiteral\("[^"]+"\),\s*QStringLiteral\("([^"]*)"\)\}/g;
let catalogMatch;
while ((catalogMatch = catalogValuePattern.exec(catalog)) !== null) {
  const line = catalog.slice(0, catalogMatch.index).split("\n").length;
  checkValue(
    path.relative(repoRoot, catalogPath).replaceAll("\\", "/"),
    line,
    catalogMatch[1],
    violations
  );
}

if (violations.length > 0) {
  console.error("External implementation branding found in user-facing native UI copy:");
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.line} contains ${violation.label}: "${violation.value}"`
    );
  }
  console.error("Use NOVA Engine / NOVA Media Engine terminology in user-facing copy.");
  process.exit(1);
}

console.log("Native product-copy branding gate passed.");
