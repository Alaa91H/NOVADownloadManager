import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const nativeCatalogPath = path.join(
  root,
  "desktop-native",
  "src",
  "localization",
  "I18nManager.cpp"
);
const bridgePath = path.join(
  root,
  "desktop-native",
  "src",
  "localization",
  "LegacyI18nCatalog.cpp"
);
const legacyEnglishPath = path.join(root, "src", "lib", "i18n", "en.ts");

const nativeSource = fs.readFileSync(nativeCatalogPath, "utf8");
const bridgeSource = fs.readFileSync(bridgePath, "utf8");
const legacySource = fs.readFileSync(legacyEnglishPath, "utf8");

const englishStart = nativeSource.indexOf("const Dictionary &english()");
const arabicStart = nativeSource.indexOf("const Dictionary &arabic()");
if (englishStart < 0 || arabicStart <= englishStart) {
  throw new Error("Unable to isolate the native English localization dictionary.");
}

const nativeEnglish = nativeSource.slice(englishStart, arabicStart);
const nativeEntryPattern =
  /\{QStringLiteral\("([^"]+)"\),\s*QStringLiteral\("((?:[^"\\]|\\.)*)"\)\}/g;

const nativeEntries = new Map();
for (const match of nativeEnglish.matchAll(nativeEntryPattern)) {
  nativeEntries.set(
    match[1],
    match[2].replaceAll("\\n", "\n").replaceAll('\\"', '"')
  );
}

const legacyEntryPattern =
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2\s*,/gm;

const legacyByKey = new Map();
const legacyKeysByEnglish = new Map();
const legacyKeysByCanonicalEnglish = new Map();

function canonicalEnglish(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}
for (const match of legacySource.matchAll(legacyEntryPattern)) {
  const key = match[1];
  const value = match[3]
    .replaceAll("\\'", "'")
    .replaceAll('\\"', '"')
    .replaceAll("\\n", "\n");
  legacyByKey.set(key, value);
  if (!legacyKeysByEnglish.has(value)) legacyKeysByEnglish.set(value, []);
  legacyKeysByEnglish.get(value).push(key);

  const canonical = canonicalEnglish(value);
  if (canonical) {
    if (!legacyKeysByCanonicalEnglish.has(canonical)) {
      legacyKeysByCanonicalEnglish.set(canonical, []);
    }
    legacyKeysByCanonicalEnglish.get(canonical).push(key);
  }
}

const aliasStart = bridgeSource.indexOf("nativeLegacyAliases()");
if (aliasStart < 0) {
  throw new Error("Native-to-legacy localization alias map is missing.");
}
const aliasEnd = bridgeSource.indexOf("return aliases;", aliasStart);
if (aliasEnd < 0) {
  throw new Error("Native-to-legacy localization alias map is malformed.");
}

const aliasSource = bridgeSource.slice(aliasStart, aliasEnd);
const aliasPattern =
  /\{QStringLiteral\("([^"]+)"\),\s*QStringLiteral\("([^"]+)"\)\}/g;
const aliases = new Map();
for (const match of aliasSource.matchAll(aliasPattern)) {
  aliases.set(match[1], match[2]);
}

function legacyKeyCandidate(nativeKey) {
  let result = "";
  for (let i = 0; i < nativeKey.length; i += 1) {
    const current = nativeKey[i];
    if (current === "." || current === "-") {
      if (result && !result.endsWith("_")) result += "_";
      continue;
    }
    if (
      /[A-Z]/.test(current) &&
      result &&
      !result.endsWith("_") &&
      i > 0 &&
      /[a-z0-9]/.test(nativeKey[i - 1])
    ) {
      result += "_";
    }
    result += current.toLowerCase();
  }
  return result;
}

const invalidAliases = [];
for (const [nativeKey, legacyKey] of aliases) {
  if (!nativeEntries.has(nativeKey)) {
    invalidAliases.push(`${nativeKey} -> ${legacyKey} (native key missing)`);
  } else if (!legacyByKey.has(legacyKey)) {
    invalidAliases.push(`${nativeKey} -> ${legacyKey} (legacy key missing)`);
  }
}

if (invalidAliases.length > 0) {
  console.error("Invalid native localization aliases:");
  for (const problem of invalidAliases) console.error(`- ${problem}`);
  process.exit(1);
}

let directMatches = 0;
let englishMatches = 0;
let canonicalMatches = 0;
let aliasMatches = 0;
const covered = new Set();

for (const [nativeKey, englishValue] of nativeEntries) {
  const directKey = legacyKeyCandidate(nativeKey);
  if (legacyByKey.has(directKey)) {
    directMatches += 1;
    covered.add(nativeKey);
  }

  if (legacyKeysByEnglish.has(englishValue)) {
    englishMatches += 1;
    covered.add(nativeKey);
  }

  const canonical = canonicalEnglish(englishValue);
  if (canonical && legacyKeysByCanonicalEnglish.has(canonical)) {
    canonicalMatches += 1;
    covered.add(nativeKey);
  }

  if (aliases.has(nativeKey)) {
    aliasMatches += 1;
    covered.add(nativeKey);
  }
}

const total = nativeEntries.size;
const coveredCount = covered.size;
const percentage = total === 0 ? 0 : (coveredCount / total) * 100;
const requiredCoverage = 42;

console.log(
  [
    "Native localization bridge coverage:",
    `${coveredCount}/${total} (${percentage.toFixed(1)}%)`,
    `direct=${directMatches}`,
    `english=${englishMatches}`,
    `canonical=${canonicalMatches}`,
    `aliases=${aliasMatches}`,
  ].join(" ")
);

if (percentage + Number.EPSILON < requiredCoverage) {
  console.error(
    `Native localization bridge coverage regressed below ${requiredCoverage}%.`
  );
  process.exit(1);
}

console.log("Native localization bridge coverage gate passed.");
