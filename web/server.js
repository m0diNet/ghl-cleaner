require("dotenv").config();

const express = require("express");
const path = require("path");
const { spawn } = require("child_process");
const { listCustomValues } = require("./services/customValuesApi");
const { defaultStore: connectionStore } = require("./services/connectionStore");
const {
  classifyConnectionError,
  discoverAccessibleLocations,
  validateConnectionForLocation,
  validateLocationAccess,
} = require("./services/ghlConnection");

const app = express();
const PORT = Number(process.env.WEB_PORT || 3000);
const ROOT = path.resolve(__dirname, "..");
const SERVER_STARTED_AT = new Date().toISOString();
const CUSTOM_VALUES_IMPORT_SCRIPT = "scripts/custom-values-import.js";

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

function errorMessage(error) {
  return String(error?.message || error?.details || "Unknown error");
}

function connectionFailureResponse(error, phase) {
  const classified = error?.code ? error : classifyConnectionError(error, phase);
  return {
    code: classified.code || "UNKNOWN_AUTH_ERROR",
    message: classified.message || "GHL connection failed.",
    details: classified.message || "GHL connection failed.",
  };
}

function getActiveConnection(req, res) {
  const connection = connectionStore.getConnection(req);
  if (!connection) {
    if (res) {
      res.status(409).json({
        success: false,
        message: "Connect a GHL account before continuing.",
      });
    }
    return null;
  }

  if (!connection.selectedLocationId) {
    if (res) {
      res.status(409).json({
        success: false,
        message: "Select an authorized GHL location before continuing.",
      });
    }
    return null;
  }

  return connection;
}

function runScript(scriptName, connection, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, scriptName)], {
      cwd: ROOT,
      env: {
        ...process.env,
        GHL_LOCATION_ID: connection.selectedLocationId,
        GHL_TOKEN: connection.token,
        BROWSER_STORAGE_STATE_PATH: connection.browserStorageStatePath || "",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(stderr || stdout || `Script failed with exit code ${code}.`);
      error.exitCode = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function parseMarker(text, marker) {
  const line = String(text || "")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(marker));

  if (!line) {
    return { success: false, message: `Missing marker ${marker}` };
  }

  try {
    return JSON.parse(line.slice(marker.length));
  } catch {
    return { success: false, message: `Invalid marker payload for ${marker}` };
  }
}

function parseCustomValueImportPayload(input) {
  const base = input && typeof input === "object" ? input : {};
  const fileMode = Boolean(base.fileName || base.fileType || base.fileText || base.fileBase64);

  return {
    mode: String(base.mode || "preview").trim() || "preview",
    locationId: String(base.locationId || "").trim(),
    token: String(base.token || "").trim(),
    targetFolderName: fileMode ? "" : String(base.targetFolderName || base.folderName || "").trim(),
    fileName: String(base.fileName || base.name || "").trim(),
    fileType: String(base.fileType || base.type || "").trim(),
    fileText: String(base.fileText || base.text || "").trim(),
    fileBase64: String(base.fileBase64 || base.base64 || "").trim(),
    rows: Array.isArray(base.rows) ? base.rows : [],
  };
}

app.use((req, res, next) => {
  connectionStore.ensureSessionId(req, res);
  next();
});

async function handleConnectionConnect(req, res) {
  const token = String(req.body.token || "").trim();
  const locationId = String(req.body.locationId || "").trim();

  if (!token) {
    return res.status(400).json({ success: false, message: "A GHL integration token is required." });
  }

  if (!locationId) {
    return res.status(400).json({ success: false, code: "INVALID_LOCATION_ID", message: "A GHL Location ID is required." });
  }

  try {
    const verified = await validateConnectionForLocation(token, locationId);
    const sessionId = connectionStore.ensureSessionId(req, res);
    const connection = connectionStore.setConnection(req, res, {
      token,
      accountName: verified.accountName,
      companyName: verified.companyName,
      locations: verified.locations,
      selectedLocationId: verified.selectedLocationId,
      selectedLocation: verified.selectedLocation,
      browserStorageStatePath: connectionStore.browserStorageStatePath(sessionId),
      connectionType: "development-token",
      authMode: "development",
    });

    res.json({
      success: true,
      connection: {
        ...connection,
        token: undefined,
      },
      selectedLocation: verified.selectedLocation,
      locations: verified.locations,
      accountName: verified.accountName,
      companyName: verified.companyName,
      mode: "development-token",
    });
  } catch (error) {
    const classified = connectionFailureResponse(error, "validate");
    res.status(error.status || error.response?.status || 400).json({ success: false, ...classified });
  }
}

app.post("/api/connection/connect", handleConnectionConnect);
app.post("/api/test-connection", handleConnectionConnect);

app.get("/api/connection/status", async (req, res) => {
  const connection = connectionStore.getConnection(req);
  if (!connection) {
    return res.json({ success: true, connected: false, connection: null });
  }

  res.json({
    success: true,
    connected: true,
    connection: connectionStore.sanitizeConnection(connection),
  });
});

app.get("/api/connection/locations", async (req, res) => {
  const connection = connectionStore.getConnection(req);
  if (!connection) {
    return res.status(409).json({ success: false, message: "Connect a GHL account before selecting a location." });
  }

  if (!connection.token) {
    return res.status(409).json({ success: false, message: "The current connection is missing an integration token." });
  }

  try {
    const discovered = await discoverAccessibleLocations(connection.token);
    const locations = Array.isArray(discovered.locations) ? discovered.locations : [];
    connectionStore.updateConnection(req, res, {
      locations,
    });
    res.json({
      success: true,
      locations,
      accountName: connection.accountName || discovered.locations[0]?.name || "Connected GHL Account",
      companyName: connection.companyName || discovered.locations[0]?.companyName || "",
    });
  } catch (error) {
    const classified = connectionFailureResponse(error, "discover");
    res.status(error.status || error.response?.status || 400).json({ success: false, ...classified });
  }
});

app.post("/api/connection/select-location", async (req, res) => {
  const connection = connectionStore.getConnection(req);
  if (!connection) {
    return res.status(409).json({ success: false, message: "Connect a GHL account before selecting a location." });
  }

  if (!connection.token) {
    return res.status(409).json({ success: false, message: "The current connection is missing an integration token." });
  }

  const locationId = String(req.body.locationId || "").trim();
  if (!locationId) {
    return res.status(400).json({ success: false, message: "Location ID is required." });
  }

  try {
    const selected = await validateLocationAccess(connection.token, locationId);
    const updated = connectionStore.setSelectedLocation(req, res, {
      id: selected.id || locationId,
      name: selected.name || "Selected GHL Location",
      companyId: selected.companyId || "",
      companyName: selected.companyName || connection.companyName || "",
    });

    return res.json({
      success: true,
      connection: updated,
      selectedLocation: updated.selectedLocation,
    });
  } catch (error) {
    const classified = connectionFailureResponse(error, "location");
    return res.status(error.status || error.response?.status || 400).json({ success: false, ...classified });
  }
});

app.post("/api/connection/disconnect", async (req, res) => {
  connectionStore.clearConnection(req, res);
  res.json({ success: true });
});

app.post("/api/custom-values/inventory", async (req, res) => {
  const values = getActiveConnection(req, res);
  if (!values) {
    return;
  }

  try {
    const inventory = await listCustomValues(values.selectedLocationId, values.token);
    res.json({
      success: true,
      verified: inventory.folderCatalogAvailable === true,
      ...inventory,
      items: Array.isArray(inventory.items) ? inventory.items : [],
      folders: Array.isArray(inventory.folders) ? inventory.folders : [],
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Custom values inventory failed.", details: errorMessage(error) });
  }
});

async function runCustomValuesSeed(req, res) {
  const values = getActiveConnection(req, res);
  if (!values) {
    return;
  }

  const folderName = String(req.body.customValueFolderName || req.body.folderName || req.body.folder || "").trim();
  const items = Array.isArray(req.body.customValues || req.body.values || req.body.items)
    ? req.body.customValues || req.body.values || req.body.items
    : [];

  if (!folderName && !items.length) {
    return res.json({
      success: true,
      created: 0,
      skipped: 0,
      failed: 0,
      values: [],
      folderName,
      folderStatus: "skipped",
      message: "No Custom Values were provided.",
    });
  }

  if (!folderName && items.length) {
    return res.status(400).json({
      success: false,
      message: "Folder Name is required when Custom Values are provided.",
    });
  }

  if (folderName && !items.length) {
    return res.json({
      success: true,
      created: 0,
      skipped: 0,
      failed: 0,
      values: [],
      folderName,
      folderStatus: "skipped",
      message: "No Custom Values were provided.",
    });
  }

  try {
    const result = parseMarker(
      (
        await runScript(CUSTOM_VALUES_IMPORT_SCRIPT, values, {
          CUSTOM_VALUES_IMPORT_JSON: JSON.stringify({
            locationId: values.selectedLocationId,
            token: values.token,
            mode: "execute",
            targetFolderName: folderName,
            rows: items,
          }),
        })
      ).stdout,
      "CUSTOM_VALUES_IMPORT_RESULT_JSON:"
    );

    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Custom values seeding failed.",
      details: errorMessage(error),
    });
  }
}

app.post("/api/custom-values/ensure", runCustomValuesSeed);
app.post("/api/custom-values/seed", runCustomValuesSeed);

app.post("/api/custom-values/import-preview", async (req, res) => {
  const values = getActiveConnection(req, res);
  if (!values) {
    return;
  }

  try {
    const result = await runScript(CUSTOM_VALUES_IMPORT_SCRIPT, values, {
      CUSTOM_VALUES_IMPORT_JSON: JSON.stringify(parseCustomValueImportPayload({
        ...req.body,
        locationId: values.selectedLocationId,
        token: values.token,
        mode: "preview",
      })),
    });
    res.json({ success: true, ...parseMarker(result.stdout, "CUSTOM_VALUES_IMPORT_RESULT_JSON:") });
  } catch (error) {
    res.status(500).json({ success: false, message: "Custom values preview failed.", details: errorMessage(error) });
  }
});

app.post("/api/custom-values/import", async (req, res) => {
  const values = getActiveConnection(req, res);
  if (!values) {
    return;
  }

  try {
    const result = await runScript(CUSTOM_VALUES_IMPORT_SCRIPT, values, {
      CUSTOM_VALUES_IMPORT_JSON: JSON.stringify(parseCustomValueImportPayload({
        ...req.body,
        locationId: values.selectedLocationId,
        token: values.token,
        mode: "execute",
      })),
    });
    res.json({ success: true, ...parseMarker(result.stdout, "CUSTOM_VALUES_IMPORT_RESULT_JSON:") });
  } catch (error) {
    res.status(500).json({ success: false, message: "Custom values import failed.", details: errorMessage(error) });
  }
});

app.get("/api/health", (_req, res) =>
  res.json({
    success: true,
    ok: true,
    status: "running",
    pid: process.pid,
    startedAt: SERVER_STARTED_AT,
  })
);

const server = app.listen(PORT, () =>
  console.log(
    `\nCustom Value Studio - GHL Custom Value Engine\nOpen: http://localhost:${PORT}\nConnection required before inventory/import\n`
  )
);

globalThis.__customValueStudioServer = server;

module.exports = { app, server };
