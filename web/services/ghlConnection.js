const axios = require("axios");
const https = require("https");
const { buildGhlHeaders } = require("./ghlApiConfig");

const BASE_URL = "https://services.leadconnectorhq.com";

function createClient(token, clientFactory = axios.create) {
  return clientFactory({
    baseURL: BASE_URL,
    timeout: 30000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    headers: {
      ...buildGhlHeaders(token),
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

function sanitizeDiagnosticData(data, depth = 0) {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string") {
    return data.length > 2000 ? `${data.slice(0, 2000)}…` : data;
  }

  if (typeof data === "number" || typeof data === "boolean") {
    return data;
  }

  if (Array.isArray(data)) {
    return data.slice(0, 20).map((item) => sanitizeDiagnosticData(item, depth + 1));
  }

  if (typeof data !== "object" || depth > 3) {
    return String(data);
  }

  const redactedKeys = /token|authorization|secret|password|cookie|session/i;
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      redactedKeys.test(key) ? "[redacted]" : sanitizeDiagnosticData(value, depth + 1),
    ])
  );
}

function logGhlConnectionDiagnostic(error, method, pathname) {
  const status = Number(error?.response?.status || 0) || "NONE";
  const code = error?.code || "NONE";
  const message = safeErrorMessage(error);
  const data = sanitizeDiagnosticData(error?.response?.data);
  console.error("GHL_CONNECTION_DIAGNOSTIC");
  console.error(`status: ${status}`);
  console.error(`code: ${code}`);
  console.error(`message: ${message}`);
  console.error(`method: ${String(method || "GET").toUpperCase()}`);
  console.error(`path: ${pathname}`);
  if (data !== undefined) {
    console.error(`data: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
}

function isLikelyPrivateIntegrationToken(token) {
  const value = String(token || "").trim();
  if (!value || value.includes(" ")) {
    return false;
  }

  return value.toLowerCase().startsWith("pit-") && value.length > 8;
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

  if (status === 429) {
    return {
      code: "GHL_RATE_LIMIT",
      status,
      message: "GHL rate limit reached. Please retry in a moment.",
      details: message,
    };
  }

  if (
    status === 401 ||
    status === 422 ||
    /invalid jwt|jwt malformed|invalid token|unauthorized|authentication failed|token is invalid/.test(normalized)
  ) {
    if (phase === "location" && status === 422) {
      return {
        code: "INVALID_LOCATION",
        status,
        message: "That Location ID could not be verified for this token.",
        details: message,
      };
    }
    if (phase === "location" && status === 422) {
      return {
        code: "INVALID_LOCATION_OR_REQUEST",
        status,
        message: "That Location ID could not be verified for this token.",
        details: message,
      };
    }
    return {
      code: "INVALID_TOKEN",
      status,
      message: "That GHL token is invalid. Paste a valid Private Integration Token.",
      details: message,
    };
  }

  if (status === 403) {
    const missingScope = /scope|permission|forbidden|not allowed|not authorized/.test(normalized);
    return {
      code: missingScope
        ? "MISSING_SCOPE"
        : phase === "location"
          ? "TOKEN_FORBIDDEN_FOR_LOCATION"
          : "TOKEN_VALID_BUT_FORBIDDEN",
      status,
      message:
        missingScope
          ? "The token is missing a required scope for this request."
          : phase === "location"
          ? "This token does not have access to the selected GHL location."
          : "The token is valid, but it does not have the required permission to list locations.",
      details: message,
    };
  }

  if (status === 404 && phase === "location") {
    return {
      code: "LOCATION_NOT_FOUND",
      status,
      message: "That Location ID could not be verified for this token.",
      details: message,
    };
  }

  if (phase === "location" && status === 400) {
    return {
      code: "INVALID_LOCATION",
      status,
      message: "That Location ID could not be verified for this token.",
      details: message,
    };
  }

  return {
    code: "GHL_API_ERROR",
    status,
    message:
      phase === "location"
        ? "That Location ID could not be verified for this token."
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

  if (!safeLocationId || safeLocationId.includes(" ")) {
    const err = new Error("Invalid Location ID.");
    err.code = "INVALID_LOCATION_ID";
    err.status = 400;
    err.details = "A valid location id is required.";
    throw err;
  }

  try {
    const response = await client.get(`/locations/${encodeURIComponent(safeLocationId)}`);
    const location = response.data?.location || response.data || {};
    const normalized = normalizeLocation(location);

    if (!normalized.id) {
      normalized.id = safeLocationId;
    }

    return normalized;
  } catch (error) {
    logGhlConnectionDiagnostic(error, "GET", `/locations/${encodeURIComponent(safeLocationId)}`);
    const classified = classifyConnectionError(error, "location");
    const err = new Error(classified.message);
    err.code = classified.code;
    err.status = classified.status;
    err.details = classified.details;
    err.response = error.response;
    throw err;
  }
}

async function validateConnectionForLocation(token, locationId, { clientFactory = axios.create } = {}) {
  if (!isLikelyPrivateIntegrationToken(token)) {
    const err = new Error("That GHL token is invalid. Paste a valid Private Integration Token.");
    err.code = "INVALID_TOKEN";
    err.status = 400;
    err.details = "Malformed token.";
    throw err;
  }

  const validatedLocation = await validateLocationAccess(token, locationId, { clientFactory });
  return {
    accountName: validatedLocation.companyName || validatedLocation.name || "Connected GHL Account",
    companyName: validatedLocation.companyName || "",
    locations: [validatedLocation],
    selectedLocation: validatedLocation,
    selectedLocationId: validatedLocation.id || String(locationId || "").trim(),
  };
}

async function validateConnection(token, { clientFactory = axios.create, allowNoAccessibleLocations = false } = {}) {
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

    if (allowNoAccessibleLocations) {
      return {
        accountName: "Connected GHL Account",
        companyName: "",
        locations: [],
        source: discovery.source,
        probe: probe?.ok ? probe.raw : null,
        warning: {
          code,
          message,
          details: discoveryError?.details || probe?.error?.details || "No accessible locations were returned.",
        },
      };
    }

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
  validateConnectionForLocation,
  validateConnection,
  validateLocationAccess,
};
