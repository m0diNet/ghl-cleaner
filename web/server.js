require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const path = require('path');
const { spawn } = require('child_process');
const { deleteSelectedApiItems } = require('./services/ghlApi');
const { scanVerifiedResources } = require('./services/verifiedScanner');
const { jobIdentity, normalizeDeleteJob, normalizeDeleteJobs } = require('./services/deleteJob');
const { defaultStore: connectionStore } = require('./services/connectionStore');
const {
  classifyConnectionError,
  discoverAccessibleLocations,
  validateConnection,
  validateLocationAccess,
} = require('./services/ghlConnection');
const {
  formatBrowserlessError,
  testBrowserlessGhlAuthStatus,
  testBrowserlessHealth,
} = require('../services/browserless');

const app = express();
const PORT = Number(process.env.WEB_PORT || 3000);
const ROOT = path.resolve(__dirname, '..');
const snapshots = new Map();
const SNAPSHOT_TTL = 30 * 60 * 1000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const clean = (value) => String(value || '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
const errorMessage = (error) => String(error?.message || error?.details || 'Unknown error');
const BROWSER_WORKER_SCRIPTS = {
  workflows: 'browser-local/workflows.js',
  forms: 'browser-local/forms.js',
  funnels: 'browser-v2/funnels.js',
};
const CUSTOM_VALUES_IMPORT_SCRIPT = 'scripts/custom-values-import.js';

function connectionFailureResponse(error, phase) {
  const classified = error?.code ? error : classifyConnectionError(error, phase);
  return {
    code: classified.code || 'UNKNOWN_AUTH_ERROR',
    message: classified.message || 'GHL connection failed.',
    details: classified.message || 'GHL connection failed.',
  };
}

function getActiveConnection(req, res) {
  const connection = connectionStore.getConnection(req);
  if (!connection) {
    if (res) {
      res.status(409).json({ success: false, message: 'Connect a GHL account before scanning, deleting, or importing.' });
    }
    return null;
  }

  if (!connection.selectedLocationId) {
    if (res) {
      res.status(409).json({ success: false, message: 'Select an authorized GHL location before continuing.' });
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
        BROWSER_STORAGE_STATE_PATH: connection.browserStorageStatePath,
        GHL_CONNECTION_ID: connection.connectionId,
        ...extraEnv,
      },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; process.stdout.write(data); });
    child.stderr.on('data', (data) => { stderr += data; process.stderr.write(data); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(clean(stderr) || clean(stdout) || `${scriptName} exited with ${code}`));
      resolve({ stdout: clean(stdout), stderr: clean(stderr) });
    });
  });
}

function parseMarker(output, marker) {
  const line = output.split('\n').find((candidate) => candidate.startsWith(marker));
  if (!line) return { results: [], deleted: 0, failed: 1, skipped: 0 };
  try { return JSON.parse(line.slice(marker.length)); }
  catch { return { results: [], deleted: 0, failed: 1, skipped: 0 }; }
}

function normalizeJobList(items, category, locationId) {
  return normalizeDeleteJobs(items, category, locationId);
}

function parseCustomValueItems(input) {
  const source = Array.isArray(input)
    ? input
    : Array.isArray(input?.items)
      ? input.items
      : Array.isArray(input?.values)
        ? input.values
        : Array.isArray(input?.customValues)
          ? input.customValues
          : [];

  return source
    .map((item) => ({
      name: String(item?.name || item?.key || "").trim(),
      value: String(item?.value || "").trim(),
    }))
    .filter((item) => item.name && item.value);
}

function parseCustomValueImportPayload(input) {
  const base = input && typeof input === "object" ? input : {};
  return {
    mode: String(base.mode || "preview").trim() || "preview",
    locationId: String(base.locationId || "").trim(),
    token: String(base.token || "").trim(),
    targetFolderName: String(base.targetFolderName || base.folderName || "").trim(),
    fileName: String(base.fileName || base.name || "").trim(),
    fileType: String(base.fileType || base.type || "").trim(),
    fileText: String(base.fileText || base.text || "").trim(),
    fileBase64: String(base.fileBase64 || base.base64 || "").trim(),
    rows: Array.isArray(base.rows) ? base.rows : [],
  };
}

function labels(resources) {
  const names = { tags: 'Tags', customFields: 'Custom Fields', customValues: 'Custom Values', workflows: 'Workflows', funnels: 'Funnels', forms: 'Forms', triggerLinks: 'Trigger Links' };
  return Object.fromEntries(Object.entries(resources).map(([category, resource]) => [category, { ...resource, label: names[category] || category }]));
}

function saveSnapshot(locationId, resources) {
  const scanId = crypto.randomUUID();
  snapshots.set(scanId, { locationId, resources, createdAt: Date.now() });
  for (const [id, snapshot] of snapshots) if (Date.now() - snapshot.createdAt > SNAPSHOT_TTL) snapshots.delete(id);
  return scanId;
}

function getSnapshot(scanId, locationId) {
  const snapshot = snapshots.get(String(scanId || ''));
  if (!snapshot || snapshot.locationId !== locationId || Date.now() - snapshot.createdAt > SNAPSHOT_TTL) return null;
  return snapshot;
}

function sanitizeAgainstSnapshot(snapshot, requested) {
  const output = {};
  for (const category of ['tags', 'customFields', 'customValues', 'triggerLinks', 'workflows', 'funnels', 'forms']) {
    const resource = snapshot.resources[category];
    if (!resource?.verified) {
      output[category] = [];
      continue;
    }
    const allowed = new Map(resource.items.map((item) => [String(jobIdentity(item) || item.id || ''), item]));
    output[category] = normalizeJobList(
      Array.isArray(requested?.[category]) ? requested[category] : [],
      category,
      snapshot.locationId
    )
      .map((item) => allowed.get(String(jobIdentity(item) || item.id || '')))
      .filter(Boolean)
      .map((item) => normalizeDeleteJob(item, category, snapshot.locationId));
  }
  return output;
}

async function browser(category, values, mode, targets) {
  const scriptName = BROWSER_WORKER_SCRIPTS[category];

  if (!scriptName) {
    throw new Error(`Unsupported browser category: ${category}`);
  }

  const normalizedJobs = normalizeJobList(targets || [], category, values.selectedLocationId);
  normalizedJobs.forEach((job) => connectionStore.ensureJobLocationMatchesConnection(job, values));
  const result = await runScript(scriptName, values, {
    BROWSER_MODE: mode,
    DELETE_JOBS_JSON: JSON.stringify(normalizedJobs),
    BROWSER_TARGETS: JSON.stringify({ [category]: normalizedJobs }),
    BROWSER_AUTO_CLOSE: 'true',
  });
  return parseMarker(result.stdout, 'BROWSER_RESULT_JSON:');
}

async function runCustomValuesImport(connection, payload) {
  const result = await runScript(CUSTOM_VALUES_IMPORT_SCRIPT, connection, {
    CUSTOM_VALUES_IMPORT_JSON: JSON.stringify(parseCustomValueImportPayload({
      ...payload,
      locationId: connection.selectedLocationId,
      token: connection.token,
    })),
  });
  return parseMarker(result.stdout, 'CUSTOM_VALUES_IMPORT_RESULT_JSON:');
}

app.use((req, res, next) => {
  connectionStore.ensureSessionId(req, res);
  next();
});

async function handleConnectionConnect(req, res) {
  const token = String(req.body.token || '').trim();
  if (!token) {
    return res.status(400).json({ success: false, message: 'A GHL integration token is required.' });
  }
  try {
    const discovered = await validateConnection(token);
    const sessionId = connectionStore.ensureSessionId(req, res);
    const connection = connectionStore.setConnection(req, res, {
      token,
      accountName: discovered.accountName,
      companyName: discovered.companyName,
      locations: discovered.locations,
      browserStorageStatePath: connectionStore.browserStorageStatePath(sessionId),
      connectionType: 'development-token',
      authMode: 'development',
    });

    res.json({
      success: true,
      connection: {
        ...connection,
        token: undefined,
      },
      locations: discovered.locations,
      accountName: discovered.accountName,
      companyName: discovered.companyName,
      mode: 'development-token',
    });
  } catch (error) {
    const classified = connectionFailureResponse(error, 'validate');
    res.status(error.status || error.response?.status || 400).json({ success: false, ...classified });
  }
}

app.post('/api/connection/connect', handleConnectionConnect);
app.post('/api/test-connection', handleConnectionConnect);

app.get('/api/connection/status', async (req, res) => {
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

app.get('/api/connection/locations', async (req, res) => {
  const connection = connectionStore.getConnection(req);
  if (!connection) {
    return res.status(409).json({ success: false, message: 'Connect a GHL account before selecting a location.' });
  }

  if (!connection.token) {
    return res.status(409).json({ success: false, message: 'The current connection is missing an integration token.' });
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
      accountName: connection.accountName || discovered.locations[0]?.name || 'Connected GHL Account',
      companyName: connection.companyName || discovered.locations[0]?.companyName || '',
    });
  } catch (error) {
    const classified = connectionFailureResponse(error, 'discover');
    res.status(error.status || error.response?.status || 400).json({ success: false, ...classified });
  }
});

app.post('/api/connection/select-location', async (req, res) => {
  const connection = connectionStore.getConnection(req);
  if (!connection) {
    return res.status(409).json({ success: false, message: 'Connect a GHL account before selecting a location.' });
  }

  if (!connection.token) {
    return res.status(409).json({ success: false, message: 'The current connection is missing an integration token.' });
  }

  const locationId = String(req.body.locationId || '').trim();
  if (!locationId) {
    return res.status(400).json({ success: false, message: 'Location ID is required.' });
  }

  try {
    const selected = await validateLocationAccess(connection.token, locationId);
    const discovered = Array.isArray(connection.locations) ? connection.locations : [];
    const allowed = discovered.find((location) => String(location.id || '').trim() === String(selected.id || locationId).trim());
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'That location is not accessible to the current connection.' });
    }

    const updated = connectionStore.setSelectedLocation(req, res, {
      id: selected.id || locationId,
      name: selected.name || allowed.name || 'Selected GHL Location',
      companyId: selected.companyId || allowed.companyId || '',
      companyName: selected.companyName || allowed.companyName || connection.companyName || '',
    });

    return res.json({
      success: true,
      connection: updated,
      selectedLocation: updated.selectedLocation,
    });
  } catch (error) {
    const classified = connectionFailureResponse(error, 'location');
    return res.status(error.status || error.response?.status || 400).json({ success: false, ...classified });
  }
});

app.post('/api/connection/disconnect', async (req, res) => {
  connectionStore.clearConnection(req, res);
  res.json({ success: true });
});

app.post('/api/scan', async (req, res) => {
  const values = getActiveConnection(req, res); if (!values) return;
  try {
    const resources = labels(await scanVerifiedResources({
      locationId: values.selectedLocationId,
      token: values.token,
    }));
    const scanId = saveSnapshot(values.selectedLocationId, resources);
    const allVerified = Object.values(resources).every((resource) => resource.verified);
    res.json({
      success: true,
      scanId,
      location: values.selectedLocation || { id: values.selectedLocationId, name: values.selectedLocation?.name || 'Connected GHL Account' },
      resources,
      allVerified,
      deletableCategories: Object.entries(resources).filter(([, resource]) => resource.verified).map(([category]) => category),
      browserCategories: ['workflows', 'funnels', 'forms'],
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Verified account scan failed.', details: errorMessage(error) });
  }
});

app.post('/api/custom-values/inventory', async (req, res) => {
  const values = getActiveConnection(req, res); if (!values) return;
  try {
    const resources = labels(await scanVerifiedResources({
      locationId: values.selectedLocationId,
      token: values.token,
    }));
    const customValues = resources.customValues || { items: [], folders: [], verified: false };
    res.json({
      success: true,
      customValues,
      items: Array.isArray(customValues.items) ? customValues.items : [],
      folders: Array.isArray(customValues.folders) ? customValues.folders : [],
      verified: Boolean(customValues.verified),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Custom values inventory failed.', details: errorMessage(error) });
  }
});

app.post('/api/delete-selected', async (req, res) => {
  const values = getActiveConnection(req, res); if (!values) return;
  const snapshot = getSnapshot(req.body.scanId, values.selectedLocationId);
  if (!snapshot) return res.status(409).json({ success: false, message: 'The verified scan expired. Scan the account again.' });
  const selections = sanitizeAgainstSnapshot(snapshot, req.body.selections);
  const requestedCategories = Object.entries(req.body.selections || {}).filter(([, list]) => Array.isArray(list) && list.length).map(([category]) => category);
  const unverified = requestedCategories.filter((category) => !snapshot.resources[category]?.verified);
  if (unverified.length) return res.status(409).json({ success: false, message: `Deletion blocked. Incomplete scan: ${unverified.join(', ')}.` });
  const total = Object.values(selections).reduce((sum, list) => sum + list.length, 0);
  if (!total) return res.status(400).json({ success: false, message: 'Select at least one verified item.' });
  try {
    const apiResult = await deleteSelectedApiItems({ locationId: values.selectedLocationId, token: values.token, selections });
    const jobs = [['workflows', selections.workflows], ['funnels', selections.funnels], ['forms', selections.forms]].filter(([, list]) => list.length);
    const browserResults = [];
    for (const [category, list] of jobs) {
      browserResults.push(await browser(category, values, list.length >= 10 ? 'selected-large' : 'selected', list));
    }
    res.json({
      success: true,
      deleted: apiResult.deleted + browserResults.reduce((sum, result) => sum + Number(result.deleted || 0), 0),
      failed: apiResult.failed + browserResults.reduce((sum, result) => sum + Number(result.failed || 0), 0),
      skipped: browserResults.reduce((sum, result) => sum + Number(result.skipped || 0), 0),
      results: [...apiResult.results, ...browserResults.flatMap((result) => result.results || [])],
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Selected deletion failed.', details: errorMessage(error) });
  }
});

app.post('/api/delete-category', async (req, res) => {
  const values = getActiveConnection(req, res); if (!values) return;
  const snapshot = getSnapshot(req.body.scanId, values.selectedLocationId);
  if (!snapshot) return res.status(409).json({ success: false, message: 'The verified scan expired. Scan the account again.' });
  const category = String(req.body.category || '').trim();
  if (!snapshot.resources[category]?.verified) return res.status(409).json({ success: false, message: `Deletion blocked. ${category} scan is incomplete.` });
  const selections = sanitizeAgainstSnapshot(snapshot, { [category]: req.body.selections?.[category] || [] });
  const items = selections[category] || [];
  if (!items.length) return res.status(400).json({ success: false, message: 'Select at least one verified item.' });
  try {
    if (['tags', 'customFields', 'customValues', 'triggerLinks'].includes(category)) {
      const apiSelections = { tags: [], customFields: [], customValues: [], triggerLinks: [] };
      apiSelections[category] = items;
      const result = await deleteSelectedApiItems({ locationId: values.selectedLocationId, token: values.token, selections: apiSelections });
      return res.json({ success: true, deleted: result.deleted, failed: result.failed, skipped: 0, results: result.results });
    }
    if (!['workflows', 'funnels', 'forms'].includes(category)) return res.status(400).json({ success: false, message: 'This category is not connected to deletion.' });
    const result = await browser(category, values, items.length >= 10 ? 'selected-large' : 'selected', items);
    return res.json({ success: true, deleted: result.deleted || 0, failed: result.failed || 0, skipped: result.skipped || 0, results: result.results || [] });
  } catch (error) {
    return res.status(500).json({ success: false, message: `Failed to delete ${category}.`, details: errorMessage(error) });
  }
});

app.post('/api/delete-all', async (req, res) => {
  const values = getActiveConnection(req, res); if (!values) return;
  if (String(req.body.confirmation || '').trim() !== 'DELETE EVERYTHING') {
    return res.status(400).json({ success: false, message: 'Type exactly "DELETE EVERYTHING".' });
  }

  const categories = Array.isArray(req.body.categories) ? req.body.categories : [];
  const apiCategories = ['tags', 'customFields', 'customValues', 'triggerLinks'];
  const browserCategories = ['workflows', 'funnels', 'forms'];

  try {
    const fresh = labels(await scanVerifiedResources({
      locationId: values.selectedLocationId,
      token: values.token,
    }));

    const requestedApiCategories = apiCategories.filter((category) => categories.includes(category));
    const incompleteApiCategories = requestedApiCategories.filter(
      (category) => !fresh[category]?.verified
    );

    if (incompleteApiCategories.length) {
      return res.status(409).json({
        success: false,
        message: `Delete Everything blocked for incomplete API categories: ${incompleteApiCategories.join(', ')}.`,
      });
    }

    const apiSelections = {
      tags: categories.includes('tags') ? fresh.tags.items : [],
      customFields: categories.includes('customFields') ? fresh.customFields.items : [],
      customValues: categories.includes('customValues') ? fresh.customValues.items : [],
      triggerLinks: categories.includes('triggerLinks') ? fresh.triggerLinks.items : [],
    };

    const apiResult = await deleteSelectedApiItems({ locationId: values.selectedLocationId, token: values.token, selections: apiSelections });

    const browserResults = [];
    for (const category of browserCategories) {
      if (!categories.includes(category)) continue;
      browserResults.push(await browser(category, values, 'all', []));
    }

    res.json({
      success: true,
      deleted: apiResult.deleted + browserResults.reduce((sum, result) => sum + Number(result.deleted || 0), 0),
      failed: apiResult.failed + browserResults.reduce((sum, result) => sum + Number(result.failed || 0), 0),
      skipped: browserResults.reduce((sum, result) => sum + Number(result.skipped || 0), 0),
      results: [...apiResult.results, ...browserResults.flatMap((result) => result.results || [])],
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Delete Everything failed.', details: errorMessage(error) });
  }
});

async function runCustomValuesSeed(req, res) {
  const values = getActiveConnection(req, res);
  if (!values) return;

  const folderName = String(
    req.body.customValueFolderName ||
      req.body.folderName ||
      req.body.folder ||
      ''
  ).trim();
  const items = parseCustomValueItems(
    req.body.customValues || req.body.values || req.body.items
  );

  if (!folderName && !items.length) {
    return res.json({
      success: true,
      created: 0,
      skipped: 0,
      failed: 0,
      values: [],
      folderName,
      folderStatus: 'skipped',
      message: 'No Custom Values were provided.',
    });
  }

  if (!folderName && items.length) {
    return res.status(400).json({
      success: false,
      message: 'Folder Name is required when Custom Values are provided.',
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
      folderStatus: 'skipped',
      message: 'No Custom Values were provided.',
    });
  }

  try {
    const result = parseMarker(
      (
        await runScript('scripts/ensure-custom-values.js', values, {
          CUSTOM_VALUE_FOLDER_NAME: folderName,
          CUSTOM_VALUES: JSON.stringify(items),
        })
      ).stdout,
      'CUSTOM_VALUES_RESULT_JSON:'
    );

    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Custom values seeding failed.',
      details: errorMessage(error),
    });
  }
}

app.post('/api/custom-values/ensure', runCustomValuesSeed);
app.post('/api/custom-values/seed', runCustomValuesSeed);
app.post('/api/custom-values/import-preview', async (req, res) => {
  const values = getActiveConnection(req, res); if (!values) return;
  try {
    const result = await runCustomValuesImport(values, {
      ...req.body,
      mode: 'preview',
    });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Custom values preview failed.', details: errorMessage(error) });
  }
});

app.post('/api/custom-values/import', async (req, res) => {
  const values = getActiveConnection(req, res); if (!values) return;
  try {
    const result = await runCustomValuesImport(values, {
      ...req.body,
      mode: 'execute',
    });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Custom values import failed.', details: errorMessage(error) });
  }
});

app.get('/api/health', (_req, res) => res.json({ success: true, status: 'running' }));

app.get('/api/browserless-health', async (_req, res) => {
  try {
    await testBrowserlessHealth();
    res.json({ success: true, connected: true });
  } catch (error) {
    res.status(503).json({
      success: false,
      connected: false,
      message: 'Browserless health check failed.',
      details: formatBrowserlessError(error),
    });
  }
});

app.get('/api/browserless-ghl-auth-status', async (req, res) => {
  const connection = connectionStore.getConnection(req);
  const result = await testBrowserlessGhlAuthStatus({
    locationId: connection?.selectedLocationId || process.env.GHL_LOCATION_ID,
    storageStatePath: connection?.browserStorageStatePath,
  });

  if (!result.browserless) {
    return res.status(503).json(result);
  }

  return res.json(result);
});

app.listen(PORT, () => console.log(`\nGHL Cleanup Service\nOpen: http://localhost:${PORT}\nBrowser automation: Browserless remote\nConnection required before scan/delete/import\n`));
