import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const themePath = path.resolve(process.cwd(), "desktop-native", "qml", "Theme.qml");
const source = fs.readFileSync(themePath, "utf8");

function propertyBlock(name) {
  const marker = `readonly property color ${name}:`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Theme color property missing: ${name}`);
  const next = source.indexOf("\n    readonly property", start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

function normalDarkLight(name) {
  const colors = [...propertyBlock(name).matchAll(/#[0-9a-fA-F]{6}/g)].map(m => m[0]);
  if (colors.length < 2) throw new Error(`Theme color pair missing: ${name}`);
  return { dark: colors.at(-2), light: colors.at(-1) };
}

function singleNormal(name) {
  const colors = [...propertyBlock(name).matchAll(/#[0-9a-fA-F]{6}/g)].map(m => m[0]);
  if (colors.length === 0) throw new Error(`Theme color missing: ${name}`);
  return colors.at(-1);
}

function rgb(hex) {
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
}

function luminance(hex) {
  const channels = rgb(hex).map(value =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const surfaces = ["window", "surface", "surfaceRaised"];
const textColors = ["textPrimary", "textSecondary", "textMuted"];
const violations = [];

for (const foregroundName of textColors) {
  const foreground = normalDarkLight(foregroundName);
  for (const backgroundName of surfaces) {
    const background = normalDarkLight(backgroundName);
    for (const mode of ["dark", "light"]) {
      const ratio = contrast(foreground[mode], background[mode]);
      if (ratio < 4.5) {
        violations.push(
          `${foregroundName}/${backgroundName} ${mode}: ${ratio.toFixed(2)}:1 < 4.5:1`
        );
      }
    }
  }
}

const accent = singleNormal("accent");
for (const backgroundName of surfaces) {
  const background = normalDarkLight(backgroundName);
  for (const mode of ["dark", "light"]) {
    const ratio = contrast(accent, background[mode]);
    if (ratio < 3.0) {
      violations.push(
        `focus accent/${backgroundName} ${mode}: ${ratio.toFixed(2)}:1 < 3.0:1`
      );
    }
  }
}

if (!/readonly property color focusRing:\s*accent\b/.test(source)) {
  violations.push("focusRing must use the validated opaque accent color");
}

if (violations.length > 0) {
  console.error("Native WCAG contrast gate failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  "Native WCAG contrast gate passed: text colors meet 4.5:1 and keyboard focus " +
    "meets 3:1 across normal light/dark window, surface and raised-surface backgrounds."
);
