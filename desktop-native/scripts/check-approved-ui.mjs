import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const contracts = [
  {
    file: "desktop-native/qml/Main.qml",
    required: [
      "Qt.FramelessWindowHint",
      "Theme.titleBarHeight",
      "customizationOpen",
      "CustomizationPanel",
      "topSearch",
      "sidebarVisible",
      "statusBarVisible",
    ],
  },
  {
    file: "desktop-native/qml/components/NavigationRail.qml",
    required: [
      "property bool collapsed: true",
      "Theme.navigationCollapsedWidth",
      "Theme.navigationExpandedWidth",
      "ToolTip.visible",
      "sidebarCollapsed",
    ],
  },
  {
    file: "desktop-native/qml/components/CommandBar.qml",
    required: [
      "component CompactAction",
      'glyph: "▶"',
      'glyph: "Ⅱ"',
      'glyph: "•••"',
      "columnsRequested",
    ],
  },
  {
    file: "desktop-native/qml/components/CustomizationPanel.qml",
    required: [
      "accentColor",
      "interfaceDensity",
      "sidebarVisible",
      "sidebarCollapsed",
      "detailsPanelVisible",
      "statusBarVisible",
      "cornerRadius",
    ],
  },
  {
    file: "desktop-native/qml/pages/DownloadsPage.qml",
    required: [
      "setSearchQuery",
      "focusSearchRequested",
      "fileGlyph",
      "detailsPanelVisible",
      "Theme.detailsWidth",
    ],
  },
  {
    file: "desktop-native/qml/components/DownloadDetailsPanel.qml",
    required: [
      "speedHistory",
      "Canvas",
      "TabBar",
      "Theme.accentMuted",
      "ProgressBar",
    ],
  },
  {
    file: "desktop-native/src/settings/NativeSettings.h",
    required: [
      "sidebarVisible",
      "sidebarCollapsed",
      "detailsPanelVisible",
      "statusBarVisible",
      "interfaceDensity",
      "accentColor",
      "cornerRadius",
    ],
  },
];

const failures = [];
for (const contract of contracts) {
  const source = read(contract.file);
  for (const token of contract.required) {
    if (!source.includes(token)) {
      failures.push(contract.file + " missing approved UI token: " + token);
    }
  }
}

if (failures.length > 0) {
  console.error("Approved native UI design contract failed:");
  for (const failure of failures) console.error("- " + failure);
  process.exit(1);
}

console.log(
  "Approved native UI design contract passed: frameless shell, compact rail, " +
    "icon command bar, persistent customization and redesigned details workspace are present."
);
