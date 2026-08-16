require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const path = require('path');
const { spawn } = require('child_process');
const { deleteSelectedApiItems } = require('./services/ghlApi');
const { scanVerifiedResources } = require('./services/verifiedScanner');
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
const errorMessage = (error) => error.response?.data?.message || error.response?.data?.error || error.message || 'Unknown error';

function credentials(req, res) {
  const locationId = String(req.body.locationId || '').trim();
  const token = String(req.body.token || '').trim();
  if (!locationId || !token) {
    res.status(400).json({ success: false, message: 'Location ID and Integration Token are required.' });
    return null;
  }
  return { locationId, token };
}

function runScript(scriptName, values, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, scriptName)], {
      cwd: ROOT,
      env: { ...process.env, GHL_LOCATION_ID: values.locationId, GHL_TOKEN: values.token, ...extraEnv },
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
    const allowed = new Map(resource.items.map((item) => [String(item.id), item]));
    output[category] = (Array.isArray(requested?.[category]) ? requested[category] : [])
      .map((item) => allowed.get(String(item.id || '')))
      .filter(Boolean)
      .map((item) => ({ id: item.id, name: item.name, type: category }));
  }
  return output;
}

async function browser(category, values, mode, targets) {
  const result = await runScript(`browser-${category}.js`, values, {
    BROWSER_MODE: mode,
    BROWSER_TARGETS: JSON.stringify(targets || []),
    BROWSER_AUTO_CLOSE: 'true',
  });
  return parseMarker(result.stdout, 'BROWSER_RESULT_JSON:');
}

app.post('/api/test-connection', async (req, res) => {
  const values = credentials(req, res); if (!values) return;
  try {
    const response = await axios.get(`https://services.leadconnectorhq.com/locations/${values.locationId}`, {
      headers: { Authorization: `Bearer ${values.token}`, Version: '2021-07-28', Accept: 'application/json' },
      timeout: 30000,
    });
    const location = response.data.location || response.data;
    res.json({ success: true, location: { id: location.id || values.locationId, name: location.name || location.business?.name || 'Connected GHL Account' } });
  } catch (error) {
    res.status(error.response?.status || 500).json({ success: false, message: 'Connection failed.', details: errorMessage(error) });
  }
});

app.post('/api/scan', async (req, res) => {
  const values = credentials(req, res); if (!values) return;
  try {
    const resources = labels(await scanVerifiedResources(values));
    const scanId = saveSnapshot(values.locationId, resources);
    const allVerified = Object.values(resources).every((resource) => resource.verified);
    res.json({
      success: true,
      scanId,
      location: { id: values.locationId, name: req.body.locationName || 'Connected GHL Account' },
      resources,
      allVerified,
      deletableCategories: Object.entries(resources).filter(([, resource]) => resource.verified).map(([category]) => category),
      browserCategories: ['workflows', 'funnels', 'forms'],
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Verified account scan failed.', details: errorMessage(error) });
  }
});

app.post('/api/delete-selected', async (req, res) => {
  const values = credentials(req, res); if (!values) return;
  const snapshot = getSnapshot(req.body.scanId, values.locationId);
  if (!snapshot) return res.status(409).json({ success: false, message: 'The verified scan expired. Scan the account again.' });
  const selections = sanitizeAgainstSnapshot(snapshot, req.body.selections);
  const requestedCategories = Object.entries(req.body.selections || {}).filter(([, list]) => Array.isArray(list) && list.length).map(([category]) => category);
  const unverified = requestedCategories.filter((category) => !snapshot.resources[category]?.verified);
  if (unverified.length) return res.status(409).json({ success: false, message: `Deletion blocked. Incomplete scan: ${unverified.join(', ')}.` });
  const total = Object.values(selections).reduce((sum, list) => sum + list.length, 0);
  if (!total) return res.status(400).json({ success: false, message: 'Select at least one verified item.' });
  try {
    const apiResult = await deleteSelectedApiItems({ ...values, selections });
    const jobs = [['workflows', selections.workflows], ['funnels', selections.funnels], ['forms', selections.forms]].filter(([, list]) => list.length);
    const browserResults = [];
    for (const [category, list] of jobs) {
      browserResults.push(
        await browser(category, values, list.length >= 10 ? 'selected-large' : 'selected', list)
      );
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
  const values = credentials(req, res); if (!values) return;
  const snapshot = getSnapshot(req.body.scanId, values.locationId);
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
      const result = await deleteSelectedApiItems({ ...values, selections: apiSelections });
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
  const values = credentials(req, res); if (!values) return;
  if (String(req.body.confirmation || '').trim() !== 'DELETE EVERYTHING') {
    return res.status(400).json({ success: false, message: 'Type exactly "DELETE EVERYTHING".' });
  }

  const categories = Array.isArray(req.body.categories) ? req.body.categories : [];
  const apiCategories = ['tags', 'customFields', 'customValues', 'triggerLinks'];
  const browserCategories = ['workflows', 'funnels', 'forms'];

  try {
    const fresh = labels(await scanVerifiedResources(values));

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

    const apiResult = await deleteSelectedApiItems({ ...values, selections: apiSelections });

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
  const values = credentials(req, res);
  if (!values) return;

  const folderName = String(req.body.folderName || req.body.folder || '').trim();
  const items = parseCustomValueItems(req.body.values || req.body.customValues || req.body.items);

  if (!folderName && !items.length) {
    return res.status(400).json({
      success: false,
      message: 'Provide a folderName, at least one custom value, or both.',
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

app.get('/api/browserless-ghl-auth-status', async (_req, res) => {
  const result = await testBrowserlessGhlAuthStatus({
    locationId: process.env.GHL_LOCATION_ID,
  });

  if (!result.browserless) {
    return res.status(503).json(result);
  }

  return res.json(result);
});

app.listen(PORT, () => console.log(`\nGHL Cleanup Service\nOpen: http://localhost:${PORT}\nBrowser automation: Browserless remote\nVerified API scan required before deletion\n`));
