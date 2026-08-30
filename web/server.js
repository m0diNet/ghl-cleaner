require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const path = require('path');
const { deleteSelectedApiItems } = require('./services/ghlApi');
const { scanVerifiedResources } = require('./services/verifiedScanner');
const { jobIdentity, normalizeDeleteJob, normalizeDeleteJobs } = require('./services/deleteJob');
const { defaultStore: connectionStore } = require('./services/connectionStore');
const {
  classifyConnectionError,
  validateLocationAccess,
} = require('./services/ghlConnection');

const app = express();
const PORT = Number(process.env.WEB_PORT || 3000);
const snapshots = new Map();
const SNAPSHOT_TTL = 30 * 60 * 1000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const errorMessage = (error) => String(error?.message || error?.details || 'Unknown error');
const SUPPORTED_DELETE_CATEGORIES = ['tags', 'customFields', 'customValues', 'triggerLinks'];

function connectionFailureResponse(error, phase) {
  const classified = error?.code ? error : classifyConnectionError(error, phase);
  return {
    code: classified.code || 'UNKNOWN_AUTH_ERROR',
    message: classified.message || 'GHL connection failed.',
    details: classified.details || classified.message || 'GHL connection failed.',
    ghlHttpStatus: classified.status || null,
    ghlErrorCode: classified.ghlErrorCode || null,
    ghlErrorMessage: classified.details || null,
  };
}

function getActiveConnection(req, res) {
  const connection = connectionStore.getConnection(req);
  if (!connection) {
    if (res) {
      res.status(409).json({ success: false, message: 'Connect a GHL account before scanning or deleting.' });
    }
    return null;
  }

  if (!connection.selectedLocationId) {
    if (res) {
      res.status(409).json({ success: false, message: 'Connect an authorized GHL location before continuing.' });
    }
    return null;
  }

  return connection;
}

function normalizeJobList(items, category, locationId) {
  return normalizeDeleteJobs(items, category, locationId);
}

function labels(resources) {
  const names = { tags: 'Tags', customFields: 'Custom Fields', customValues: 'Custom Values', triggerLinks: 'Trigger Links' };
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
  for (const category of SUPPORTED_DELETE_CATEGORIES) {
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

app.use((req, res, next) => {
  connectionStore.ensureSessionId(req, res);
  next();
});

async function handleConnectionConnect(req, res) {
  const token = String(req.body.token || '').trim();
  const locationId = String(req.body.locationId || '').trim();
  if (!token) {
    return res.status(400).json({ success: false, message: 'A GHL integration token is required.' });
  }
  if (!locationId) {
    return res.status(400).json({ success: false, message: 'A GHL Location ID is required.' });
  }
  console.log(`[CONNECTION] request received: true locationId: ${locationId} tokenPresent: ${Boolean(token)} tokenLength: ${token.length}`);
  try {
    console.log(`[CONNECTION] GHL validation attempted: GET /locations/${encodeURIComponent(locationId)}`);
    const location = await validateLocationAccess(token, locationId);
    connectionStore.ensureSessionId(req, res);
    const connection = connectionStore.setConnection(req, res, {
      token,
      accountName: location.name || location.companyName || 'Connected GHL Account',
      companyName: location.companyName || location.name || '',
      locations: [location],
      selectedLocationId: location.id || locationId,
      selectedLocation: location,
      selectedAt: new Date().toISOString(),
      connectionType: 'development-token',
      authMode: 'development',
    });

    res.json({
      success: true,
      connected: true,
      locationId: connection.selectedLocationId,
      locationName: connection.selectedLocation?.name || connection.selectedLocationName || '',
      connection,
    });
  } catch (error) {
    const classified = connectionFailureResponse(error, 'location');
    console.log(`[CONNECTION] GHL validation failed: status=${classified.ghlHttpStatus || 'network'} code=${classified.ghlErrorCode || 'none'} message=${classified.ghlErrorMessage || classified.message}`);
    const responseStatus = Number(classified.ghlHttpStatus) || (classified.code === 'HIGHLEVEL_UNAVAILABLE' ? 502 : 400);
    res.status(responseStatus).json({ success: false, ...classified });
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
      supportedCategories: SUPPORTED_DELETE_CATEGORIES,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Verified account scan failed.', details: errorMessage(error) });
  }
});

app.post('/api/delete-selected', async (req, res) => {
  const values = getActiveConnection(req, res); if (!values) return;
  const requestedSelections = req.body.selections && typeof req.body.selections === 'object' ? req.body.selections : {};
  const unsupported = Object.keys(requestedSelections).filter((category) => !SUPPORTED_DELETE_CATEGORIES.includes(category));
  if (unsupported.length) return res.status(400).json({ success: false, message: `Unsupported deletion category: ${unsupported.join(', ')}.` });
  const snapshot = getSnapshot(req.body.scanId, values.selectedLocationId);
  if (!snapshot) return res.status(409).json({ success: false, message: 'The verified scan expired. Scan the account again.' });
  const selections = sanitizeAgainstSnapshot(snapshot, requestedSelections);
  const requestedCategories = Object.entries(requestedSelections).filter(([, list]) => Array.isArray(list) && list.length).map(([category]) => category);
  const unverified = requestedCategories.filter((category) => !snapshot.resources[category]?.verified);
  if (unverified.length) return res.status(409).json({ success: false, message: `Deletion blocked. Incomplete scan: ${unverified.join(', ')}.` });
  const total = Object.values(selections).reduce((sum, list) => sum + list.length, 0);
  if (!total) return res.status(400).json({ success: false, message: 'Select at least one verified item.' });
  try {
    const apiResult = await deleteSelectedApiItems({ locationId: values.selectedLocationId, token: values.token, selections });
    res.json({
      success: true,
      deleted: apiResult.deleted,
      failed: apiResult.failed,
      verificationFailed: apiResult.verificationFailed,
      skipped: 0,
      results: apiResult.results,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Selected deletion failed.', details: errorMessage(error) });
  }
});

app.post('/api/delete-category', async (req, res) => {
  const values = getActiveConnection(req, res); if (!values) return;
  const category = String(req.body.category || '').trim();
  if (!SUPPORTED_DELETE_CATEGORIES.includes(category)) {
    return res.status(400).json({ success: false, message: `Unsupported deletion category: ${category || 'missing'}.` });
  }
  const snapshot = getSnapshot(req.body.scanId, values.selectedLocationId);
  if (!snapshot) return res.status(409).json({ success: false, message: 'The verified scan expired. Scan the account again.' });
  if (!snapshot.resources[category]?.verified) return res.status(409).json({ success: false, message: `Deletion blocked. ${category} scan is incomplete.` });
  const selections = sanitizeAgainstSnapshot(snapshot, { [category]: req.body.selections?.[category] || [] });
  const items = selections[category] || [];
  if (!items.length) return res.status(400).json({ success: false, message: 'Select at least one verified item.' });
  try {
    const apiSelections = { tags: [], customFields: [], customValues: [], triggerLinks: [] };
    apiSelections[category] = items;
    const result = await deleteSelectedApiItems({ locationId: values.selectedLocationId, token: values.token, selections: apiSelections });
    return res.json({ success: true, deleted: result.deleted, failed: result.failed, verificationFailed: result.verificationFailed, skipped: 0, results: result.results });
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
  const unsupported = categories.filter((category) => !SUPPORTED_DELETE_CATEGORIES.includes(category));
  if (unsupported.length) return res.status(400).json({ success: false, message: `Unsupported deletion category: ${unsupported.join(', ')}.` });

  try {
    const fresh = labels(await scanVerifiedResources({
      locationId: values.selectedLocationId,
      token: values.token,
    }));

    const requestedApiCategories = SUPPORTED_DELETE_CATEGORIES.filter((category) => categories.includes(category));
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

    res.json({
      success: true,
      deleted: apiResult.deleted,
      failed: apiResult.failed,
      verificationFailed: apiResult.verificationFailed,
      skipped: 0,
      results: apiResult.results,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Delete Everything failed.', details: errorMessage(error) });
  }
});

app.get('/api/health', (_req, res) => res.json({ success: true, status: 'running' }));

const server = app.listen(PORT, () => console.log(`\nGHL Cleanup Service\nOpen: http://localhost:${PORT}\nAPI-only deletion engine\nConnection required before scan/delete\n`));

server.on('error', (error) => {
  console.error(`Unable to start the GHL Cleanup Service on port ${PORT}: ${error.message}`);
  process.exitCode = 1;
});
