import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function chromeExtensionIdFromPublicKey(base64Key) {
  const der = Buffer.from(base64Key, "base64");
  const digest = createHash("sha256").update(der).digest().subarray(0, 16);
  const alphabet = "abcdefghijklmnop";
  let id = "";
  for (const byte of digest) {
    id += alphabet[(byte >> 4) & 0x0f];
    id += alphabet[byte & 0x0f];
  }
  return id;
}

const manifestPath = "browser-extension/src/manifest.json";
const manifest = JSON.parse(read(manifestPath));
const desktopSource = read("desktop-native/src/platform/DesktopIntegration.cpp");
const nativeTransportSource = read("browser-extension/src/transport/native-transport.ts");
const daemonSource = read("src-tauri/src/daemon/mod.rs");

const errors = [];

if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes("nativeMessaging")) {
  errors.push("Browser manifest must request nativeMessaging permission");
}

if (typeof manifest.key !== "string" || manifest.key.trim().length === 0) {
  errors.push("Browser manifest must pin a public key so the Chromium extension ID is stable");
}

const chromiumId =
  typeof manifest.key === "string" && manifest.key.trim().length > 0
    ? chromeExtensionIdFromPublicKey(manifest.key.trim())
    : "";

const chromiumOrigin = chromiumId ? "chrome-extension://" + chromiumId : "";
const chromiumManifestOrigin = chromiumOrigin ? chromiumOrigin + "/" : "";
const firefoxId = manifest.browser_specific_settings?.gecko?.id;
const hostName = "com.nova.downloadmanager";

if (!chromiumId) {
  errors.push("Unable to derive Chromium extension ID from manifest key");
}

if (!firefoxId || typeof firefoxId !== "string") {
  errors.push("Firefox extension ID is missing from browser_specific_settings.gecko.id");
}

if (
  !nativeTransportSource.includes("constructor(private readonly host = '" + hostName + "')")
) {
  errors.push("NativeTransport host name drifted from " + hostName);
}

for (const [label, source, expected] of [
  ["Qt native-host manifest name", desktopSource, 'QStringLiteral("' + hostName + '")'],
  ["Qt Chromium allowed origin", desktopSource, 'QStringLiteral("' + chromiumManifestOrigin + '")'],
  ["Qt Firefox allowed extension", desktopSource, 'QStringLiteral("' + firefoxId + '")'],
  ["Rust Chromium extension origin", daemonSource, '"' + chromiumOrigin + '"'],
]) {
  if (!source.includes(expected)) {
    errors.push(label + " does not match browser manifest identity: expected " + expected);
  }
}

const pinnedRustOrigin = daemonSource.match(
  /NOVA_CHROMIUM_EXTENSION_ORIGIN:\s*&str\s*=\s*"([^"]+)"/
)?.[1];
if (pinnedRustOrigin && pinnedRustOrigin !== chromiumOrigin) {
  errors.push(
    "Rust pinned Chromium origin " + pinnedRustOrigin +
      " does not match derived origin " + chromiumOrigin
  );
}

if (errors.length > 0) {
  console.error("Browser Native Messaging identity contract failed:");
  for (const error of errors) console.error("- " + error);
  process.exit(1);
}

console.log(
  "Browser Native Messaging identity contract passed: host=" + hostName +
    ", chromiumId=" + chromiumId + ", firefoxId=" + firefoxId
);
