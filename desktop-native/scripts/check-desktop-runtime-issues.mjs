import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const bootstrap = read("src/platform/BackendBootstrap.cpp");
const bootstrapHeader = read("src/platform/BackendBootstrap.h");
const main = read("src/main.cpp");
const mainQml = read("qml/Main.qml");
const settings = read("qml/pages/SettingsPage.qml");
const torrent = read("qml/components/TorrentDetailsPanel.qml");
const pairing = readFileSync(
  new URL("../../src-tauri/src/daemon/routes/extension.rs", import.meta.url),
  "utf8",
);
const pairingConstants = readFileSync(
  new URL("../../src-tauri/src/daemon/mod.rs", import.meta.url),
  "utf8",
);

const failures = [];
const requireMatch = (condition, message) => {
  if (!condition) failures.push(message);
};

requireMatch(
  /setCreateProcessArgumentsModifier[\s\S]*?CREATE_NO_WINDOW/.test(bootstrap),
  "The bundled console backend must start without creating a terminal window.",
);
requireMatch(
  !/ForwardedErrorChannel/.test(bootstrap),
  "The GUI must not forward backend stderr to the launching terminal.",
);
requireMatch(
  /QQuickStyle::setStyle\(QStringLiteral\("Basic"\)\)/.test(main)
    && main.indexOf("QQuickStyle::setStyle") < main.indexOf("QApplication app"),
  "Qt Quick Controls must use Basic before the GUI application is created.",
);
requireMatch(
  /desktopIntegration\.displayMetrics\(\)/.test(mainQml)
    && /availableGeometry/.test(mainQml)
    && !/window\.showMaximized\(\)/.test(mainQml),
  "The frameless window must maximize to the screen work area.",
);
requireMatch(
  /Layout\.fillWidth:\s*true[\s\S]{0,120}Layout\.fillHeight:\s*true/.test(settings)
    && /columns:\s*root\.width\s*</.test(settings)
    && /wrapMode:\s*Text\.WordWrap/.test(settings),
  "Settings need full-width scroll pages, responsive columns, and wrapped labels.",
);
requireMatch(
  /visible:\s*Boolean\(root\.details\.requiresReauth\)/.test(torrent),
  "Optional torrent reauthorization data must be converted to a defined boolean.",
);
requireMatch(
  /NATIVE_DESKTOP_PAIRING_HEADER/.test(pairing)
    && /x-nova-native-desktop/.test(pairingConstants)
    && /x-nova-native-desktop/.test(bootstrap)
    && !/pairingSecret\.isEmpty\(\)/.test(bootstrap),
  "Desktop auto-pair must use the same accepted marker on both sides.",
);
requireMatch(
  /appDir\.filePath\(QStringLiteral\("\.\.\/"\) \+ fileName\)/.test(bootstrap)
    && /setWorkingDirectory\(info\.absolutePath\(\)\)/.test(bootstrap)
    && /com\.nova\.downloadmanager\/nova-daemon\.port/.test(bootstrap)
    && /m_portsToProbe = candidatePorts\(\)/.test(bootstrap)
    && /m_backendOutput\.append\(m_backendProcess\.readAllStandardError\(\)\)/.test(bootstrap),
  "The desktop must launch the packaged backend from its bundle directory and probe the daemon port persisted by the runtime before its fallback range.",
);
requireMatch(
  /reportBootstrapFailure/.test(bootstrapHeader)
    && /backend-bootstrap\.log/.test(bootstrap),
  "Backend startup failures must be recorded for support diagnostics.",
);
requireMatch(
  /Accessible\.name: window\.t\("nav\.settings"\)/.test(mainQml)
    && /onClicked: \{\s*window\.customizationOpen = false\s*window\.currentPage = "settings"/.test(mainQml),
  "The top-bar gear must navigate to application settings instead of opening appearance customization.",
);
requireMatch(
  /source:\s*"qrc:\/qt\/qml\/Nova\/Native\/nova-mark\.png"/.test(mainQml)
    && /QT_RESOURCE_ALIAS nova-mark\.png/.test(
      readFileSync(new URL("../../desktop-native/CMakeLists.txt", import.meta.url), "utf8"),
    ),
  "The top bar must use the packaged NOVA logo resource instead of a text-only mark.",
);
requireMatch(
  /id:\s*customizationButton[\s\S]{0,450}Accessible\.name:\s*window\.t\("custom\.open"\)[\s\S]{0,200}customizationOpen = !window\.customizationOpen/.test(mainQml)
    && /id:\s*settingsButton[\s\S]{0,350}Accessible\.name:\s*window\.t\("nav\.settings"\)[\s\S]{0,220}window\.currentPage = "settings"/.test(mainQml),
  "The header must provide distinct, labeled controls for app settings and quick customization.",
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Desktop runtime regression contracts passed.");
}
