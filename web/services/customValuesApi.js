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

const BASE_URL = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

function createClient(token, clientFactory = axios.create) {
  return clientFactory({
    baseURL: BASE_URL,
    timeout: 30000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Version: VERSION,
    },
  });
}

function buildCustomValuePayload(item) {
  return {
    name: toText(item.name),
    value: toText(item.value),
  };
}

function extractCustomValueFolders(data) {
  const candidates = [
    data?.folders,
    data?.customValueFolders,
    data?.data?.folders,
    data?.data?.customValueFolders,
  ];
  return candidates.find((value) => Array.isArray(value)) || [];
}

async function listCustomValues(locationId, token, { clientFactory = axios.create } = {}) {
  const client = createClient(token, clientFactory);
  const response = await client.get(`/locations/${locationId}/customValues`);
  const items = extractCustomValueItems(response.data).map(normalizeExistingCustomValue);
  return buildCustomValueInventory(items, extractCustomValueFolders(response.data));
}

function matchByName(items, name) {
  const target = normalizeName(name);
  return (Array.isArray(items) ? items : []).filter((item) => normalizeName(item.name) === target);
}

async function createCustomValue(locationId, token, item, { clientFactory = axios.create } = {}) {
  const client = createClient(token, clientFactory);
  const payload = buildCustomValuePayload(item);
  const response = await client.post(`/locations/${locationId}/customValues`, payload);
  return response.data;
}

async function updateCustomValue(locationId, token, item, { clientFactory = axios.create } = {}) {
  const client = createClient(token, clientFactory);
  const payload = buildCustomValuePayload(item);

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

async function ensureCustomValue(locationId, token, item, { clientFactory = axios.create, associateFolder = null } = {}) {
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

  const moveFolder = typeof associateFolder === "function" ? associateFolder : null;

  if (!match) {
    await createCustomValue(locationId, token, {
      ...item,
    }, { clientFactory });
    const createdInventory = await listCustomValues(locationId, token, { clientFactory });
    const createdMatches = matchByName(createdInventory.items, item.name);
    const created = createdMatches.find((candidate) => String(candidate.value || "") === String(item.value || "")) || null;
    if (!created) {
      return {
        status: "failed",
        before: match,
        after: null,
        folder: findCustomValueFolder(createdInventory, desiredFolder.folderName, desiredFolder.folderId),
        folderVerified: false,
      };
    }
    let moveResult = null;
    if (moveFolder && desiredFolder.folderName) {
      moveResult = await moveFolder({
        locationId,
        token,
        item: {
          ...item,
          id: created.id,
        },
        desiredFolder,
        phase: "create",
        clientFactory,
      });
    }
    const after = await listCustomValues(locationId, token, { clientFactory });
    const finalCreatedMatches = matchByName(after.items, item.name);
    const finalCreated = finalCreatedMatches.find((candidate) => String(candidate.value || "") === String(item.value || "")) || null;
    const association = verifyCustomValueFolderAssociation(after, desiredFolder.folderName, desiredFolder.folderId);
    const folderVerified = Boolean(moveResult?.folderVerified || association.verified);
    return {
      status: finalCreated && folderVerified ? "created" : "failed",
      before: match,
      after: finalCreated,
      folder: association.folder,
      folderVerified,
      associationSource: moveResult?.folderVerified ? "browserless-ui" : "api-readback",
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

  let moveResult = null;
  await updateCustomValue(locationId, token, {
    ...item,
    id: match.id,
  }, { clientFactory });
  if (moveFolder && desiredFolder.folderName) {
    moveResult = await moveFolder({
      locationId,
      token,
      item: {
        ...item,
        id: match.id,
      },
      desiredFolder,
      phase: "update",
      clientFactory,
    });
  }
  const after = await listCustomValues(locationId, token, { clientFactory });
  const updatedMatches = matchByName(after.items, item.name);
  const updated = updatedMatches.find((candidate) => String(candidate.value || "") === String(item.value || "")) || updatedMatches[0] || null;
  const association = verifyCustomValueFolderAssociation(after, desiredFolder.folderName, desiredFolder.folderId);
  const folderVerified = Boolean(moveResult?.folderVerified || association.verified);

  return {
    status: updated && folderVerified ? "updated" : "failed",
    before: match,
    after: updated,
    folder: association.folder,
    folderVerified,
    associationSource: moveResult?.folderVerified ? "browserless-ui" : "api-readback",
  };
}

module.exports = {
  buildCustomValuePayload,
  createCustomValue,
  ensureCustomValue,
  listCustomValues,
  updateCustomValue,
  findCustomValueFolder,
};
