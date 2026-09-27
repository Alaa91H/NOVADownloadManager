import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const source = fs.readFileSync(
  path.join(root, "desktop-native", "src", "localization", "I18nManager.cpp"),
  "utf8"
);

function dictionarySection(name, nextName) {
  const start = source.indexOf("const Dictionary &" + name + "()");
  const end = source.indexOf("const Dictionary &" + nextName + "()", start + 1);
  if (start < 0 || end <= start) {
    throw new Error("Unable to isolate " + name + " localization dictionary");
  }
  return source.slice(start, end);
}

function parseDictionary(section, label) {
  const pattern =
    /\{QStringLiteral\("([^"]+)"\),\s*QStringLiteral\("((?:[^"\\]|\\.)*)"\)\}/g;
  const entries = [];
  for (const match of section.matchAll(pattern)) {
    entries.push([match[1], match[2]]);
  }

  const keys = new Set();
  const duplicates = [];
  const empty = [];
  for (const [key, value] of entries) {
    if (keys.has(key)) duplicates.push(key);
    keys.add(key);
    if (value.trim().length === 0) empty.push(key);
  }

  if (duplicates.length > 0) {
    throw new Error(label + " has duplicate keys: " + duplicates.join(", "));
  }
  if (empty.length > 0) {
    throw new Error(label + " has empty translations: " + empty.join(", "));
  }

  return new Map(entries);
}

const english = parseDictionary(dictionarySection("english", "arabic"), "English");
const arabic = parseDictionary(dictionarySection("arabic", "german"), "Arabic");

const missingArabic = [...english.keys()].filter(key => !arabic.has(key));
const extraArabic = [...arabic.keys()].filter(key => !english.has(key));

if (missingArabic.length > 0 || extraArabic.length > 0) {
  console.error("English/Arabic localization parity failed.");
  if (missingArabic.length > 0) {
    console.error("- Missing Arabic keys: " + missingArabic.join(", "));
  }
  if (extraArabic.length > 0) {
    console.error("- Arabic-only keys: " + extraArabic.join(", "));
  }
  process.exit(1);
}

const supportedStart = source.indexOf("QVariantList I18nManager::supportedLanguages() const");
const supportedEnd = source.indexOf("QString I18nManager::translate", supportedStart);
if (supportedStart < 0 || supportedEnd <= supportedStart) {
  throw new Error("Unable to inspect release language list");
}
const supported = source.slice(supportedStart, supportedEnd);
const releaseCodes = [...supported.matchAll(
  /\{QStringLiteral\("code"\),\s*QStringLiteral\("([^"]+)"\)\}/g
)].map(match => match[1]);

if (JSON.stringify(releaseCodes) !== JSON.stringify(["en", "ar"])) {
  console.error(
    "Release language list must be exactly [en, ar], got: " +
      JSON.stringify(releaseCodes)
  );
  process.exit(1);
}

console.log(
  "Release localization gate passed: English/Arabic only, " +
    english.size + "/" + english.size + " Arabic keys covered."
);
