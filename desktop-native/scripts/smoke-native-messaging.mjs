import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const bundleRoot = process.argv[2];
if (!bundleRoot) {
  throw new Error("Usage: node smoke-native-messaging.mjs <preview-bundle-root>");
}

const absoluteRoot = path.resolve(bundleRoot);
const hostName = process.platform === "win32" ? "nova-native-host.exe" : "nova-native-host";

function findFile(root, name) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return fullPath;
    if (entry.isDirectory()) {
      const found = findFile(fullPath, name);
      if (found) return found;
    }
  }
  return null;
}

function nativeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function makeFrameReader(stream) {
  let buffer = Buffer.alloc(0);
  const waiters = [];

  function drain() {
    while (waiters.length > 0 && buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (size <= 0 || size > 1024 * 1024) {
        waiters.shift().reject(new Error("Invalid native response length: " + size));
        return;
      }
      if (buffer.length < 4 + size) return;

      const body = buffer.subarray(4, 4 + size);
      buffer = buffer.subarray(4 + size);
      const waiter = waiters.shift();
      try {
        waiter.resolve(JSON.parse(body.toString("utf8")));
      } catch (error) {
        waiter.reject(error);
      }
    }
  }

  stream.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });

  return function readFrame(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for native messaging response"));
      }, timeoutMs);
      waiters.push({
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      drain();
    });
  };
}

async function sendRequest(child, readFrame, request) {
  child.stdin.write(nativeFrame(request));
  const response = await readFrame();
  if (response.id !== request.id) {
    throw new Error(
      "Native response id mismatch: expected " + request.id + ", received " + response.id
    );
  }
  if (response.ok !== true) {
    throw new Error(
      "Native request " + request.method + " failed: " + JSON.stringify(response.error)
    );
  }
  return response.result;
}

const hostPath = findFile(absoluteRoot, hostName);
if (!hostPath) {
  throw new Error("Packaged native host not found below " + absoluteRoot);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-native-host-smoke-"));
const pairingSecret = "0123456789abcdef0123456789abcdef";
const pairToken = "smoke-browser-token-0123456789abcdef";

const observed = {
  pairProof: false,
  captureAuth: false,
  capturePayload: false,
  capabilities: false,
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = {};
      }
    }

    const json = (status, value) => {
      const payload = Buffer.from(JSON.stringify(value));
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(payload.length),
      });
      res.end(payload);
    };

    if (req.method === "GET" && req.url === "/v1/ping") {
      json(200, { ok: true, service: "nova-smoke" });
      return;
    }

    if (req.method === "POST" && req.url === "/v1/pair/auto") {
      observed.pairProof =
        req.headers["x-nova-native-host"] === "1" &&
        req.headers["x-nova-pairing-secret"] === pairingSecret;
      if (!observed.pairProof) {
        json(403, { error: "invalid pairing proof" });
        return;
      }
      json(200, {
        ok: true,
        pairToken,
        autoApproved: true,
        protocolVersion: 4,
      });
      return;
    }

    if (req.method === "GET" && req.url === "/api/engines/capabilities") {
      observed.capabilities = true;
      json(200, { engines: { native: { available: true } } });
      return;
    }

    if (req.method === "POST" && req.url === "/v1/capture-reviews") {
      observed.captureAuth = req.headers.authorization === "Bearer " + pairToken;
      observed.capturePayload =
        body.url === "https://example.test/file.iso" &&
        body.filename === "file.iso" &&
        body.referrer === "https://example.test/page";
      if (!observed.captureAuth) {
        json(401, { error: "missing browser bearer token" });
        return;
      }
      json(200, {
        accepted: false,
        captureId: "native-host-smoke",
        reason: "smoke-test-review-only",
      });
      return;
    }

    json(404, { error: "unexpected route " + req.method + " " + req.url });
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Failed to allocate loopback smoke-test port");
}
const port = address.port;

fs.writeFileSync(
  path.join(dataDir, "nova-daemon.port"),
  String(port) + "\n" + String(process.pid) + "\n",
  "utf8"
);
fs.writeFileSync(
  path.join(dataDir, "nova-daemon.pairing.json"),
  JSON.stringify({
    port,
    pid: process.pid,
    secret: pairingSecret,
    protocolVersion: 1,
  }),
  "utf8"
);

const child = spawn(hostPath, ["--native-host"], {
  env: {
    ...process.env,
    NOVA_NATIVE_DATA_DIR: dataDir,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", chunk => {
  stderr += chunk;
});

const readFrame = makeFrameReader(child.stdout);

try {
  const pair = await sendRequest(child, readFrame, {
    id: "pair",
    method: "auth.pair",
    params: {},
  });
  if (pair.pairToken !== pairToken || pair.protocolVersion !== 4) {
    throw new Error("Unexpected auth.pair result: " + JSON.stringify(pair));
  }

  const capabilities = await sendRequest(child, readFrame, {
    id: "capabilities",
    method: "capabilities",
    params: {},
  });
  if (!capabilities.engines || !capabilities.engines.native || !capabilities.engines.native.available) {
    throw new Error("Packaged host did not proxy capabilities");
  }

  const capture = await sendRequest(child, readFrame, {
    id: "capture",
    method: "candidate.send",
    params: {
      url: "https://example.test/file.iso",
      filename: "file.iso",
      referrer: "https://example.test/page",
    },
  });
  if (capture.captureId !== "native-host-smoke") {
    throw new Error("Unexpected capture result: " + JSON.stringify(capture));
  }

  for (const [name, value] of Object.entries(observed)) {
    if (!value) throw new Error("Native Messaging smoke assertion failed: " + name);
  }
} finally {
  child.stdin.end();
  const exitCode = child.exitCode !== null
    ? child.exitCode
    : await new Promise(resolve => {
        const timer = setTimeout(() => {
          child.kill();
          resolve(-1);
        }, 5000);
        child.once("exit", code => {
          clearTimeout(timer);
          resolve(code ?? -1);
        });
      });

  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });

  if (exitCode !== 0) {
    throw new Error(
      "Packaged native host exited with " + exitCode + ". stderr: " + stderr.trim()
    );
  }
}

console.log(
  "Packaged Native Messaging smoke passed for " + hostPath +
  ": pairing proof, protocol v4, capabilities proxy and authenticated capture handoff verified."
);
