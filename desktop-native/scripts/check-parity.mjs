import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const manifestPath = path.join(repoRoot, "desktop-native", "parity", "parity-manifest.json");
const reportDir = path.join(repoRoot, "build");
const reportPath = path.join(reportDir, "native-parity-report.md");

const expectedCapabilities = [
  "downloads-live",
  "single-download",
  "download-actions",
  "file-actions",
  "queue",
  "scheduler",
  "batch-import",
  "media",
  "link-grabber",
  "settings-diagnostics",
  "desktop-integration",
  "keyboard-rtl-theme",
  "native-localization",
  "search-filter",
  "columns-sorting",
  "browser-integration",
  "clipboard-monitoring",
  "signed-updater",
  "platform-validation",
  "accessibility-hidpi",
  "large-list-recovery",
];

const allowedStatuses = new Set(["covered", "partial", "gap", "blocked"]);

function fail(errors) {
  for (const error of errors) console.error("::error::" + error);
  process.exit(1);
}

if (!fs.existsSync(manifestPath)) {
  fail([`Missing parity manifest: ${manifestPath}`]);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const errors = [];
const seen = new Set();

if (manifest.schemaVersion !== 1) errors.push("Unsupported parity manifest schemaVersion.");
if (manifest.stage !== "6-parity-freeze") errors.push("Parity manifest stage must be 6-parity-freeze.");
if (!Array.isArray(manifest.capabilities)) errors.push("Manifest capabilities must be an array.");

const rows = [];
let covered = 0;
let partial = 0;
let gap = 0;
let blocked = 0;

for (const item of manifest.capabilities || []) {
  if (!item.id || typeof item.id !== "string") {
    errors.push("Capability without a valid id.");
    continue;
  }
  if (seen.has(item.id)) errors.push(`Duplicate capability id: ${item.id}`);
  seen.add(item.id);

  if (!allowedStatuses.has(item.status)) {
    errors.push(`Capability ${item.id} has unsupported status ${item.status}`);
  }

  if (item.status === "covered") {
    covered += 1;
    if (item.blocker) errors.push(`Covered capability ${item.id} must not have a blocker.`);
  } else if (item.status === "partial") {
    partial += 1;
    if (!item.blocker) errors.push(`Partial capability ${item.id} must explain its blocker.`);
  } else if (item.status === "gap") {
    gap += 1;
    if (!item.blocker) errors.push(`Gap capability ${item.id} must explain its blocker.`);
  } else if (item.status === "blocked") {
    blocked += 1;
    if (!item.blocker) errors.push(`Blocked capability ${item.id} must explain its blocker.`);
  }

  const evidence = [...(item.evidence || []), ...(item.legacyEvidence || [])];
  if (evidence.length === 0) {
    errors.push(`Capability ${item.id} has no evidence files.`);
  }

  for (const relativePath of evidence) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      errors.push(`Capability ${item.id} references missing evidence: ${relativePath}`);
    }
  }

  for (const check of item.contains || []) {
    const absolutePath = path.join(repoRoot, check.file);
    if (!fs.existsSync(absolutePath)) {
      errors.push(`Capability ${item.id} contains-check references missing file: ${check.file}`);
      continue;
    }
    const source = fs.readFileSync(absolutePath, "utf8");
    for (const needle of check.allOf || []) {
      if (!source.includes(needle)) {
        errors.push(`Capability ${item.id} evidence ${check.file} is missing required token: ${needle}`);
      }
    }
  }

  rows.push({
    id: item.id,
    label: item.label || item.id,
    status: item.status,
    blocker: item.blocker || "",
  });
}

for (const id of expectedCapabilities) {
  if (!seen.has(id)) errors.push(`Required parity gate missing from manifest: ${id}`);
}

if (errors.length > 0) fail(errors);

fs.mkdirSync(reportDir, { recursive: true });

const lines = [
  "# NOVA Native UI Parity Report",
  "",
  `Preview version: **${manifest.nativePreviewVersion || "unknown"}**`,
  "",
  `Coverage summary: **${covered} covered**, **${partial} partial**, **${gap} gaps**, **${blocked} blocked**.`,
  "",
  "| Capability | Status | Notes |",
  "| --- | --- | --- |",
];

for (const row of rows) {
  lines.push(`| ${row.label.replaceAll("|", "\\|")} | ${row.status.toUpperCase()} | ${(row.blocker || "Evidence verified by parity gate.").replaceAll("|", "\\|")} |`);
}

lines.push(
  "",
  "## Stage 6 policy",
  "",
  "- Covered capabilities must keep their evidence files and required implementation tokens.",
  "- Existing parity gaps stay explicit until implemented; they are not silently treated as complete.",
  "- New native preview builds must carry this report so QA can see current blockers.",
  ""
);

fs.writeFileSync(reportPath, lines.join("\n"), "utf8");

console.log(`Parity gate passed: ${covered} covered, ${partial} partial, ${gap} gaps, ${blocked} blocked.`);
console.log(`Report written to ${path.relative(repoRoot, reportPath)}`);
