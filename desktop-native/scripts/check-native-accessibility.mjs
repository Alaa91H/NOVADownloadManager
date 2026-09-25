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

function componentBlocks(source, typeName) {
  const blocks = [];
  const pattern = new RegExp("\\b" + typeName + "\\s*\\{", "g");
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
    if (end < 0) throw new Error(`Unbalanced ${typeName} block in QML.`);
    blocks.push({ start: match.index, source: source.slice(match.index, end) });
    pattern.lastIndex = end;
  }
  return blocks;
}

function delegateBlock(listViewSource) {
  const match = /delegate\s*:\s*[A-Za-z0-9_.]+\s*\{/.exec(listViewSource);
  if (!match) return null;

  const braceStart = listViewSource.indexOf("{", match.index);
  let depth = 0;
  for (let i = braceStart; i < listViewSource.length; i += 1) {
    const ch = listViewSource[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return listViewSource.slice(match.index, i + 1);
      }
    }
  }
  return null;
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

  for (const field of componentBlocks(source, "TextField")) {
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

  for (const listView of componentBlocks(source, "ListView")) {
    const line = lineNumber(source, listView.start);
    const delegateOffset = listView.source.indexOf("delegate:");
    const listHeader =
      delegateOffset >= 0 ? listView.source.slice(0, delegateOffset) : listView.source;

    if (!/activeFocusOnTab\s*:\s*true/.test(listHeader)) {
      violations.push({
        file: relative,
        line,
        message: "ListView must be reachable through Tab navigation",
      });
    }
    if (!/keyNavigationWraps\s*:\s*false/.test(listHeader)) {
      violations.push({
        file: relative,
        line,
        message: "ListView must define bounded keyboard arrow navigation",
      });
    }
    if (!/Accessible\.role\s*:\s*Accessible\.List\b/.test(listHeader)) {
      violations.push({
        file: relative,
        line,
        message: "ListView is missing Accessible.List semantics",
      });
    }
    if (!/Accessible\.name\s*:/.test(listHeader)) {
      violations.push({
        file: relative,
        line,
        message: "ListView is missing an Accessible.name",
      });
    }

    const delegate = delegateBlock(listView.source);
    if (delegate) {
      if (!/Accessible\.role\s*:\s*Accessible\.ListItem\b/.test(delegate)) {
        violations.push({
          file: relative,
          line,
          message: "ListView delegate is missing Accessible.ListItem semantics",
        });
      }
      if (!/Accessible\.name\s*:/.test(delegate)) {
        violations.push({
          file: relative,
          line,
          message: "ListView delegate is missing an Accessible.name",
        });
      }
      for (const property of ["focusable", "focused", "selectable", "selected"]) {
        const pattern = new RegExp("Accessible\\." + property + "\\s*:");
        if (!pattern.test(delegate)) {
          violations.push({
            file: relative,
            line,
            message: `ListView delegate is missing Accessible.${property}`,
          });
        }
      }
      if (!/Theme\.focusRing/.test(delegate)) {
        violations.push({
          file: relative,
          line,
          message: "ListView delegate is missing a visible keyboard focus indicator",
        });
      }
    }
  }

  if (
    relative.endsWith("/ConfirmDeleteDialog.qml") ||
    relative.endsWith("/ConfirmRedownloadDialog.qml")
  ) {
    if (!/onOpened\s*:\s*[A-Za-z0-9_]+\.forceActiveFocus\(\)/.test(source)) {
      violations.push({
        file: relative,
        line: 1,
        message: "confirmation dialog must move focus to a safe action when opened",
      });
    }
    const tabLinks = source.match(/KeyNavigation\.(?:tab|backtab)\s*:/g) || [];
    if (tabLinks.length < 4) {
      violations.push({
        file: relative,
        line: 1,
        message: "confirmation dialog must define an explicit forward/backward focus loop",
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
    "monospace technical fields are LTR, font sizes respect Theme.fontScale, " +
    "ListViews expose List/ListItem focus-selection semantics with visible focus, " +
    "and confirmation dialogs define safe focus loops."
);
