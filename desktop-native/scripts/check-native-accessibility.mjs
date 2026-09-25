import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const qmlRoot = path.resolve(process.cwd(), "desktop-native", "qml");

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".qml")) files.push(fullPath);
  }
  return files;
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function textFieldBlocks(source) {
  const blocks = [];
  const pattern = /\bTextField\s*\{/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    let depth = 0;
    let end = -1;
    for (let i = match.index; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) throw new Error("Unbalanced TextField block in QML.");
    blocks.push({ start: match.index, source: source.slice(match.index, end) });
    pattern.lastIndex = end;
  }
  return blocks;
}

const violations = [];

for (const file of walk(qmlRoot)) {
  const source = fs.readFileSync(file, "utf8");
  const relative = path.relative(process.cwd(), file).replaceAll("\\", "/");

  const numericFontPattern = /font\.pixelSize\s*:\s*(\d+(?:\.\d+)?)\b/g;
  let fontMatch;
  while ((fontMatch = numericFontPattern.exec(source)) !== null) {
    violations.push({
      file: relative,
      line: lineNumber(source, fontMatch.index),
      message: `fixed font.pixelSize ${fontMatch[1]} bypasses Theme.fontScale`,
    });
  }

  for (const field of textFieldBlocks(source)) {
    const line = lineNumber(source, field.start);
    if (!/Accessible\.name\s*:/.test(field.source)) {
      violations.push({
        file: relative,
        line,
        message: "TextField is missing Accessible.name",
      });
    }

    if (
      /font\.family\s*:\s*"monospace"/.test(field.source) &&
      (!/LayoutMirroring\.enabled\s*:\s*false/.test(field.source) ||
        !/horizontalAlignment\s*:\s*Text\.AlignLeft/.test(field.source))
    ) {
      violations.push({
        file: relative,
        line,
        message: "monospace technical TextField must stay explicitly LTR",
      });
    }
  }
}

if (violations.length > 0) {
  console.error("Native accessibility/typography gate failed:");
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.line} ${violation.message}`
    );
  }
  process.exit(1);
}

console.log(
  "Native accessibility/typography gate passed: all TextFields are named, " +
    "monospace technical fields are LTR, and font sizes respect Theme.fontScale."
);
