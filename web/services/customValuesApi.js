const axios = require("axios");
const https = require("https");
const {
  buildCustomValueInventory,
  extractCustomValueItems,
  findCustomValueFolder,
  normalizeExistingCustomValue,
  normalizeName,
  verifyCustomValueFolderAssociation,
  toText,
} = require("./customValuesImport");
const { API_VERSION } = require("./ghlApiConfig");

const BASE_URL = "https://services.leadconnectorhq.com";

function createClient(token, clientFactory = axios.create) {
  return clientFactory({
    baseURL: BASE_URL,
    timeout: 30000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Version: API_VERSION,
    },
  });
}

async function listCustomValues(locationId, token, { clientFactory = axios.create } = {}) {
  const client = createClient(token, clientFactory);
  const response = await client.get(`/locations/${locationId}/customValues`);
  const items = extractCustomValueItems(response.data).map(normalizeExistingCustomValue);
  return buildCustomValueInventory(items);
}

function matchByName(items, name) {
  const target = normalizeName(name);
  return (Array.isArray(items) ? items : []).filter((item) => normalizeName(item.name) === target);
}

async function createCustomValue(locationId, token, item, { clientFactory = axios.create } = {}) {
  const client = createClient(token, clientFactory);
  const payload = {
    name: toText(item.name),
    value: toText(item.value),
  };

  if (item.folderId) {
    payload.folderId = toText(item.folderId);
  }

  if (item.folderName) {
    payload.folderName = toText(item.folderName);
  }

  const response = await client.post(`/locations/${locationId}/customValues`, payload);
  return response.data;
}

async function updateCustomValue(locationId, token, item, { clientFactory = axios.create } = {}) {
  const client = createClient(token, clientFactory);
  const payload = {
    name: toText(item.name),
    value: toText(item.value),
  };

  if (item.folderId) {
    payload.folderId = toText(item.folderId);
  }

  if (item.folderName) {
    payload.folderName = toText(item.folderName);
  }

  const urls = [
    `/locations/${locationId}/customValues/${encodeURIComponent(item.id)}`,
    `/locations/${locationId}/customValues/${encodeURIComponent(item.id)}/`,
  ];

  let lastError = null;
  for (const url of urls) {
    try {
      const response = await client.patch(url, payload);
      return response.data;
    } catch (error) {
      lastError = error;
      try {
        const response = await client.put(url, payload);
        return response.data;
      } catch (putError) {
        lastError = putError;
      }
    }
  }

  throw lastError || new Error(`Unable to update custom value "${item.name}".`);
}

async function ensureCustomValue(locationId, token, item, { clientFactory = axios.create } = {}) {
  const before = await listCustomValues(locationId, token, { clientFactory });
  const matches = matchByName(before.items, item.name);
  const match = matches[0] || null;
  if (matches.length > 1) {
    return {
      status: "conflict",
      before: matches,
      after: null,
      folder: findCustomValueFolder(before, item.folderName, item.folderId || ""),
    };
  }

  const requestedFolder = findCustomValueFolder(before, item.folderName, item.folderId || "");
  const folderName = toText(item.folderName || requestedFolder?.folderName || "");
  const folderId = toText(item.folderId || requestedFolder?.folderId || "");
  const desiredFolder = {
    folderId: folderId || "",
    folderName: folderName || "",
  };

  if (!match) {
    await createCustomValue(locationId, token, {
      ...item,
      folderId: desiredFolder.folderId || "",
      folderName: desiredFolder.folderName || "",
    }, { clientFactory });
    const after = await listCustomValues(locationId, token, { clientFactory });
    const createdMatches = matchByName(after.items, item.name);
    const created = createdMatches.find((candidate) => String(candidate.value || "") === String(item.value || "")) || createdMatches[0] || null;
    const association = verifyCustomValueFolderAssociation(after, desiredFolder.folderName, desiredFolder.folderId);
    return {
      status: created && association.verified ? "created" : "failed",
      before: match,
      after: created,
      folder: association.folder,
      folderVerified: association.verified,
    };
  }

  const sameValue = String(match.value || "") === String(item.value || "");
  const sameFolder =
    normalizeName(match.folderName || "") === normalizeName(desiredFolder.folderName || match.folderName || "") &&
    (!desiredFolder.folderId || !toText(match.folderId || "") || toText(match.folderId || "") === desiredFolder.folderId);

  if (sameValue && sameFolder) {
    return {
      status: "unchanged",
      before: match,
      after: match,
      folder: findCustomValueFolder(before, desiredFolder.folderName, desiredFolder.folderId),
      folderVerified: true,
    };
  }

  await updateCustomValue(locationId, token, {
    ...item,
    id: match.id,
    folderId: desiredFolder.folderId || "",
    folderName: desiredFolder.folderName || "",
  }, { clientFactory });
  const after = await listCustomValues(locationId, token, { clientFactory });
  const updatedMatches = matchByName(after.items, item.name);
  const updated = updatedMatches.find((candidate) => String(candidate.value || "") === String(item.value || "")) || updatedMatches[0] || null;
  const association = verifyCustomValueFolderAssociation(after, desiredFolder.folderName, desiredFolder.folderId);

  return {
    status: updated && association.verified ? "updated" : "failed",
    before: match,
    after: updated,
    folder: association.folder,
    folderVerified: association.verified,
  };
}

module.exports = {
  createCustomValue,
  ensureCustomValue,
  listCustomValues,
  updateCustomValue,
  findCustomValueFolder,
};
