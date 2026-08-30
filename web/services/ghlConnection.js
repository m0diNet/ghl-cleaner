const axios = require("axios");
const { API_VERSION, BASE_URL } = require("./ghlApiConfig");

function sanitizeMessage(value) {
  return String(value || "")
    .replace(/Bearer\s+[^\s,]+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-token]")
    .trim();
}

function createClient(token, clientFactory = axios.create) {
  return clientFactory({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Version: API_VERSION,
    },
  });
}

function safeErrorMessage(error) {
  const data = error?.response?.data;
  if (typeof data === "string" && data.trim()) {
    return sanitizeMessage(data);
  }

  if (data && typeof data === "object") {
    const message = sanitizeMessage(data.message || data.error || data.details || "");
    if (message) {
      return message;
    }
  }

  return sanitizeMessage(error?.message || "Unknown GHL error") || "Unknown GHL error";
}

function safeErrorCode(error) {
  const data = error?.response?.data;
  return String(data?.code || data?.errorCode || data?.error_code || "").trim() || null;
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

  if (
    error?.code === "ECONNABORTED" ||
    error?.code === "ENOTFOUND" ||
    error?.code === "EAI_AGAIN" ||
    error?.code === "ECONNRESET" ||
    error?.code === "ETIMEDOUT"
  ) {
    return {
      code: "HIGHLEVEL_UNAVAILABLE",
      status,
      message: "Unable to reach HighLevel right now.",
      details: message,
      ghlErrorCode: safeErrorCode(error),
    };
  }

  if (status === 401) {
    return {
      code: phase === "location" ? "AUTHENTICATION_FAILED" : "INVALID_TOKEN",
      status,
      message: phase === "location"
        ? "Authentication failed. Check your Private Integration Token."
        : "That GHL token is invalid. Paste a valid Private Integration Token.",
      details: message,
      ghlErrorCode: safeErrorCode(error),
    };
  }

  if (status === 403) {
    return {
      code: phase === "location" ? "LOCATION_ACCESS_FORBIDDEN" : "TOKEN_VALID_BUT_FORBIDDEN",
      status,
      message:
        phase === "location"
          ? "The token does not have permission to access this location."
          : "The token is valid, but it does not have the required permission to list locations.",
      details: message,
      ghlErrorCode: safeErrorCode(error),
    };
  }

  if (status === 404 && phase === "location") {
    return {
      code: "LOCATION_NOT_FOUND_OR_INACCESSIBLE",
      status,
      message: "Location not found or this token cannot access that Location ID.",
      details: message,
      ghlErrorCode: safeErrorCode(error),
    };
  }

  if (status === 429) {
    return {
      code: "RATE_LIMITED",
      status,
      message: "HighLevel rate limit reached. Try again shortly.",
      details: message,
      ghlErrorCode: safeErrorCode(error),
    };
  }

  if (status >= 500) {
    return {
      code: "HIGHLEVEL_UNAVAILABLE",
      status,
      message: "Unable to reach HighLevel right now.",
      details: message,
      ghlErrorCode: safeErrorCode(error),
    };
  }

  return {
    code: "HIGHLEVEL_REQUEST_FAILED",
    status,
    message: "HighLevel rejected the connection request.",
    details: message,
    ghlErrorCode: safeErrorCode(error),
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
