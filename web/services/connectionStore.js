const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_COOKIE_NAME = "ghl_session_id";
const CONNECTIONS_DIR = path.join(__dirname, "..", "..", "browser-state", "connections");

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeSessionId(value) {
  return String(value || "").trim();
}

function parseCookies(headerValue) {
  return String(headerValue || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, pair) => {
      const index = pair.indexOf("=");
      if (index <= 0) {
        return cookies;
      }

      const name = decodeURIComponent(pair.slice(0, index).trim());
      const value = decodeURIComponent(pair.slice(index + 1).trim());
      cookies[name] = value;
      return cookies;
    }, {});
}

function buildCookie(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  parts.push("HttpOnly");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(Number(options.maxAge)))}`);
  }
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function browserStorageStatePath(sessionId) {
  const safeId = normalizeSessionId(sessionId) || crypto.randomUUID();
  return path.join(CONNECTIONS_DIR, `${safeId}.json`);
}

function createConnectionStore(options = {}) {
  const cookieName = String(options.cookieName || DEFAULT_COOKIE_NAME).trim() || DEFAULT_COOKIE_NAME;
  const sessions = new Map();

  function getSessionId(req) {
    const cookies = parseCookies(req.headers?.cookie || "");
    return normalizeSessionId(cookies[cookieName]);
  }

  function ensureSessionId(req, res) {
    const existing = getSessionId(req);
    if (existing) {
      return existing;
    }

    const sessionId = crypto.randomUUID();
    if (res && typeof res.setHeader === "function") {
      const cookie = buildCookie(cookieName, sessionId, {
        path: "/",
        sameSite: "Lax",
      });
      const current = res.getHeader ? res.getHeader("Set-Cookie") : null;
      const next = Array.isArray(current)
        ? [...current, cookie]
        : current
          ? [current, cookie]
          : [cookie];
      res.setHeader("Set-Cookie", next);
    }

    return sessionId;
  }

  function sanitizeConnection(record) {
    if (!record) {
      return null;
    }

    const locations = Array.isArray(record.locations) ? record.locations : [];
    return {
      connectionId: record.connectionId,
      connectionType: record.connectionType || "development-token",
      accountName: record.accountName || "",
      companyName: record.companyName || "",
      selectedLocationId: record.selectedLocationId || "",
      selectedLocation: record.selectedLocation || null,
      selectedLocationName: record.selectedLocation?.name || "",
      selectedAt: record.selectedAt || null,
      createdAt: record.createdAt || null,
      lastUsedAt: record.lastUsedAt || null,
      locations: locations.map((location) => ({
        id: location.id || "",
        name: location.name || "",
        companyId: location.companyId || "",
        companyName: location.companyName || "",
      })),
    };
  }

  function touch(record) {
    if (record) {
      record.lastUsedAt = new Date().toISOString();
    }
    return record;
  }

  function getConnectionBySessionId(sessionId) {
    const key = normalizeSessionId(sessionId);
    if (!key) {
      return null;
    }

    const record = sessions.get(key) || null;
    return touch(record);
  }

  function getConnection(req) {
    return getConnectionBySessionId(getSessionId(req));
  }

  function setConnection(req, res, data = {}) {
    const sessionId = ensureSessionId(req, res);
    const now = new Date().toISOString();
    const record = {
      connectionId: sessionId,
      connectionType: String(data.connectionType || "development-token").trim() || "development-token",
      token: String(data.token || ""),
      accountName: String(data.accountName || ""),
      companyName: String(data.companyName || ""),
      locations: Array.isArray(data.locations) ? data.locations : [],
      selectedLocationId: String(data.selectedLocationId || "").trim(),
      selectedLocation: data.selectedLocation || null,
      selectedAt: data.selectedAt || null,
      createdAt: data.createdAt || now,
      lastUsedAt: now,
      browserStorageStatePath: String(data.browserStorageStatePath || browserStorageStatePath(sessionId)).trim(),
      authMode: String(data.authMode || "development").trim() || "development",
    };

    sessions.set(sessionId, record);
    return sanitizeConnection(record);
  }

  function updateConnection(req, res, patch = {}) {
    const sessionId = ensureSessionId(req, res);
    const existing = sessions.get(sessionId);
    if (!existing) {
      return null;
    }

    if (patch.token !== undefined) {
      existing.token = String(patch.token || "");
    }
    if (patch.accountName !== undefined) {
      existing.accountName = String(patch.accountName || "");
    }
    if (patch.companyName !== undefined) {
      existing.companyName = String(patch.companyName || "");
    }
    if (patch.locations !== undefined) {
      existing.locations = Array.isArray(patch.locations) ? patch.locations : [];
    }
    if (patch.selectedLocationId !== undefined) {
      existing.selectedLocationId = String(patch.selectedLocationId || "").trim();
    }
    if (patch.selectedLocation !== undefined) {
      existing.selectedLocation = patch.selectedLocation || null;
    }
    if (patch.selectedAt !== undefined) {
      existing.selectedAt = patch.selectedAt || null;
    }
    if (patch.browserStorageStatePath !== undefined) {
      existing.browserStorageStatePath = String(patch.browserStorageStatePath || browserStorageStatePath(sessionId)).trim();
    }
    if (patch.authMode !== undefined) {
      existing.authMode = String(patch.authMode || existing.authMode || "development").trim() || "development";
    }
    if (patch.connectionType !== undefined) {
      existing.connectionType = String(patch.connectionType || existing.connectionType || "development-token").trim() || "development-token";
    }

    existing.lastUsedAt = new Date().toISOString();
    return sanitizeConnection(existing);
  }

  function setSelectedLocation(req, res, location) {
    const sessionId = ensureSessionId(req, res);
    const existing = sessions.get(sessionId);
    if (!existing) {
      return null;
    }

    existing.selectedLocationId = String(location?.id || "").trim();
    existing.selectedLocation = location || null;
    existing.selectedAt = new Date().toISOString();
    existing.lastUsedAt = existing.selectedAt;
    return sanitizeConnection(existing);
  }

  function clearConnection(req, res) {
    const sessionId = getSessionId(req);
    if (sessionId) {
      const record = sessions.get(sessionId);
      const storageStatePath = String(record?.browserStorageStatePath || browserStorageStatePath(sessionId)).trim();
      if (storageStatePath && fs.existsSync(storageStatePath)) {
        try {
          fs.unlinkSync(storageStatePath);
        } catch {
          // Best-effort cleanup; the in-memory session still gets cleared below.
        }
      }
      sessions.delete(sessionId);
    }

    if (res && typeof res.setHeader === "function") {
      const expired = buildCookie(cookieName, "", {
        path: "/",
        sameSite: "Lax",
        maxAge: 0,
      });
      const current = res.getHeader ? res.getHeader("Set-Cookie") : null;
      const next = Array.isArray(current)
        ? [...current, expired]
        : current
          ? [current, expired]
          : [expired];
      res.setHeader("Set-Cookie", next);
    }
  }

  function requireConnection(req, res) {
    const connection = getConnection(req);
    if (!connection) {
      if (res) {
        res.status(409).json({
          success: false,
          message: "Connect a GHL account before scanning, deleting, or importing.",
        });
      }
      return null;
    }

    return connection;
  }

  function requireSelectedLocation(req, res) {
    const connection = requireConnection(req, res);
    if (!connection) {
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

  function isJobForSelectedLocation(job, connection) {
    const jobLocationId = String(job?.locationId || "").trim();
    const selectedLocationId = String(connection?.selectedLocationId || "").trim();
    return Boolean(jobLocationId && selectedLocationId && jobLocationId === selectedLocationId);
  }

  function ensureJobLocationMatchesConnection(job, connection) {
    if (!isJobForSelectedLocation(job, connection)) {
      const error = new Error("Delete job location must match the selected connection location.");
      error.code = "LOCATION_MISMATCH";
      throw error;
    }
  }

  return {
    browserStorageStatePath,
    clearConnection,
    ensureSessionId,
    getConnection,
    getConnectionBySessionId,
    getSessionId,
    isJobForSelectedLocation,
    requireConnection,
    requireSelectedLocation,
    sanitizeConnection,
    setConnection,
    setSelectedLocation,
    updateConnection,
    ensureJobLocationMatchesConnection,
    cookieName,
  };
}

const defaultStore = createConnectionStore();

module.exports = {
  browserStorageStatePath,
  buildCookie,
  createConnectionStore,
  defaultStore,
  parseCookies,
};
