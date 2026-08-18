const axios = require("axios");

const BASE_URL = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

function createClient(token, clientFactory = axios.create) {
  return clientFactory({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Version: VERSION,
    },
  });
}

function safeErrorMessage(error) {
  const data = error?.response?.data;
  if (typeof data === "string" && data.trim()) {
    return data.trim();
  }

  if (data && typeof data === "object") {
    const message = String(data.message || data.error || data.details || "").trim();
    if (message) {
      return message;
    }
  }

  return String(error?.message || "Unknown GHL error").trim() || "Unknown GHL error";
}

function isLikelyPrivateIntegrationToken(token) {
  const value = String(token || "").trim();
  if (!value || value.includes(" ")) {
    return false;
  }

  const parts = value.split(".");
  if (parts.length !== 3) {
    return false;
  }

  return parts.every((part) => Boolean(part.trim()));
}

function classifyConnectionError(error, phase = "generic") {
  const status = Number(error?.response?.status || 0);
  const message = safeErrorMessage(error);
  const normalized = message.toLowerCase();

  if (
    error?.code === "ECONNABORTED" ||
    error?.code === "ENOTFOUND" ||
    error?.code === "EAI_AGAIN" ||
    error?.code === "ECONNRESET" ||
    error?.code === "ETIMEDOUT"
  ) {
    return {
      code: "NETWORK_ERROR",
      status,
      message: "Could not reach GHL. Check the connection and try again.",
      details: message,
    };
  }

  if (
    status === 401 ||
    status === 422 ||
    /invalid jwt|jwt malformed|invalid token|unauthorized|authentication failed|token is invalid/.test(normalized)
  ) {
    return {
      code: "INVALID_TOKEN",
      status,
      message: "That GHL token is invalid. Paste a valid Private Integration Token.",
      details: message,
    };
  }

  if (status === 403) {
    return {
      code: phase === "location" ? "LOCATION_NOT_AUTHORIZED" : "TOKEN_VALID_BUT_FORBIDDEN",
      status,
      message:
        phase === "location"
          ? "This token does not have access to the selected GHL location."
          : "The token is valid, but it does not have the required permission to list locations.",
      details: message,
    };
  }

  if (status === 404 && phase === "location") {
    return {
      code: "LOCATION_NOT_AUTHORIZED",
      status,
      message: "This token does not have access to the selected GHL location.",
      details: message,
    };
  }

  return {
    code: "UNKNOWN_AUTH_ERROR",
    status,
    message:
      phase === "location"
        ? "This token does not have access to the selected GHL location."
        : "GHL connection failed. Please try again.",
    details: message,
  };
}

async function probeToken(token, { clientFactory = axios.create } = {}) {
  const client = createClient(token, clientFactory);
  try {
    const response = await client.get("/users/search", { params: { limit: 1, skip: 0 } });
    return {
      ok: true,
      raw: response.data,
    };
  } catch (error) {
    const classified = classifyConnectionError(error, "validate");
    const err = new Error(classified.message);
    err.code = classified.code;
    err.status = classified.status;
    err.details = classified.details;
    err.response = error.response;
    throw err;
  }
}

function extractArray(data, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], data);
    if (Array.isArray(value)) {
      return value;
    }
  }

  if (Array.isArray(data)) {
    return data;
  }

  return [];
}

function normalizeLocation(item) {
  const id = String(
    item?.id ||
      item?._id ||
      item?.locationId ||
      item?.subAccountId ||
      item?.companyId ||
      ""
  ).trim();
  const name = String(
    item?.name ||
      item?.locationName ||
      item?.businessName ||
      item?.business?.name ||
      item?.title ||
      "Unnamed location"
  ).trim();
  const companyName = String(
    item?.companyName ||
      item?.accountName ||
      item?.business?.name ||
      item?.businessName ||
      ""
  ).trim();

  return {
    id,
    name,
    companyId: String(item?.companyId || item?.businessId || "").trim(),
    companyName,
    raw: item,
  };
}

async function discoverAccessibleLocations(token, { clientFactory = axios.create } = {}) {
  const client = createClient(token, clientFactory);
  const candidates = [
    { path: "/locations/search", params: { limit: 100, skip: 0 } },
    { path: "/locations", params: { limit: 100, skip: 0 } },
  ];

  let lastError = null;
  const attempts = [];

  for (const candidate of candidates) {
    try {
      const response = await client.get(candidate.path, { params: candidate.params });
      const items = extractArray(response.data, [
        "locations",
        "subAccounts",
        "subaccounts",
        "accounts",
        "companies",
        "data.locations",
        "data.subAccounts",
        "data.subaccounts",
        "data.accounts",
        "data.companies",
      ]);
      const locations = items.map(normalizeLocation).filter((location) => location.id && location.name);
      attempts.push({ path: candidate.path, status: response.status, count: locations.length });
      if (locations.length) {
        return {
          locations,
          raw: response.data,
          source: candidate.path,
          attempts,
        };
      }
    } catch (error) {
      const status = error.response?.status;
      attempts.push({
        path: candidate.path,
        status: status || 0,
        errorCode: classifyConnectionError(error, "discover").code,
      });
      lastError = error;
    }
  }

  return {
    locations: [],
    raw: null,
    source: "",
    attempts,
    lastError,
  };
}

async function validateLocationAccess(token, locationId, { clientFactory = axios.create } = {}) {
  const client = createClient(token, clientFactory);
  const safeLocationId = String(locationId || "").trim();

  try {
    const response = await client.get(`/locations/${encodeURIComponent(safeLocationId)}`);
    const location = response.data?.location || response.data || {};
    const normalized = normalizeLocation(location);

    if (!normalized.id) {
      normalized.id = safeLocationId;
    }

    return normalized;
  } catch (error) {
    const classified = classifyConnectionError(error, "location");
    const err = new Error(classified.message);
    err.code = classified.code;
    err.status = classified.status;
    err.details = classified.details;
    err.response = error.response;
    throw err;
  }
}

async function validateConnection(token, { clientFactory = axios.create } = {}) {
  if (!isLikelyPrivateIntegrationToken(token)) {
    const err = new Error("That GHL token is invalid. Paste a valid Private Integration Token.");
    err.code = "INVALID_TOKEN";
    err.status = 400;
    err.details = "Malformed token.";
    throw err;
  }

  let probe = null;
  try {
    probe = await probeToken(token, { clientFactory });
  } catch (error) {
    if (error.code === "INVALID_TOKEN" || error.code === "NETWORK_ERROR") {
      throw error;
    }
    probe = { ok: false, error };
  }

  const discovery = await discoverAccessibleLocations(token, { clientFactory });
  const locations = Array.isArray(discovery.locations) ? discovery.locations : [];
  if (!locations.length) {
    const discoveryError = discovery.lastError ? classifyConnectionError(discovery.lastError, "discover") : null;
    const code =
      discoveryError?.code ||
      (probe?.error ? classifyConnectionError(probe.error, "validate").code : "NO_ACCESSIBLE_LOCATIONS");
    const message =
      code === "TOKEN_VALID_BUT_FORBIDDEN"
        ? "The token is valid, but it does not have permission to list any accessible GHL locations."
        : code === "LOCATION_NOT_AUTHORIZED"
          ? "This token does not have access to the selected GHL location."
          : code === "INVALID_TOKEN"
            ? "That GHL token is invalid. Paste a valid Private Integration Token."
            : code === "NETWORK_ERROR"
              ? "Could not reach GHL. Check the connection and try again."
              : "This token did not return any accessible GHL locations.";

    const err = new Error(message);
    err.code = code;
    err.status = discoveryError?.status || probe?.error?.response?.status || 0;
    err.details = discoveryError?.details || probe?.error?.details || "No accessible locations were returned.";
    throw err;
  }

  const accountName = locations[0]?.companyName || locations[0]?.name || "Connected GHL Account";
  const companyName = locations[0]?.companyName || accountName;

  return {
    accountName,
    companyName,
    locations,
    source: discovery.source,
    probe: probe?.ok ? probe.raw : null,
  };
}

module.exports = {
  classifyConnectionError,
  discoverAccessibleLocations,
  isLikelyPrivateIntegrationToken,
  normalizeLocation,
  probeToken,
  validateConnection,
  validateLocationAccess,
};
