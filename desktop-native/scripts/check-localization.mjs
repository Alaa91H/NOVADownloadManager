import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.cwd(), "desktop-native", "qml");
const allowed = new Set([
  "%(title)s.%(ext)s",
  "Optional: 1-10,15,20",
  "N",
  "NOVA",
  "HTTP",
  // Syntax samples, format identifiers and units shown verbatim to users.
  "bestvideo+bestaudio/best",
  "res,codec:avc:m4a",
  "duration < 3600",
  "mp4",
  "sponsor,selfpromo",
  "Header-Name: value",
  "name=value",
  "KB/s",
]);

function walk(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".qml")) {
      files.push(fullPath);
    }
  }
  return files;
}

const propertyPattern =
  /\b(text|placeholderText|title|Accessible\.name|Accessible\.description)\s*:\s*"([^"\n]*)"/g;

const violations = [];
for (const file of walk(root)) {
  const source = fs.readFileSync(file, "utf8");
  let match;
  while ((match = propertyPattern.exec(source)) !== null) {
    const value = match[2].trim();
    if (!/[A-Za-z]/.test(value)) continue;
    if (/^https?:\/\//i.test(value)) continue;
    if (allowed.has(value)) continue;

    const line = source.slice(0, match.index).split("\n").length;
    violations.push({
      file: path.relative(process.cwd(), file).replaceAll("\\", "/"),
      line,
      property: match[1],
      value,
    });
  }
}

if (violations.length > 0) {
  console.error("Hard-coded user-visible English text found in native QML:");
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.line} ${violation.property}: "${violation.value}"`
    );
  }
  console.error("Move UI copy into I18nManager or explicitly allow a technical literal.");
  process.exit(1);
}

console.log("Native QML localization gate passed.");
