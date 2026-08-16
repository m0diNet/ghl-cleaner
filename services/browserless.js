require("dotenv").config({ quiet: true });

const fs = require("fs");
const https = require("https");
const path = require("path");
const { URL } = require("url");
const { chromium } = require("playwright");

const DEFAULT_CONNECT_TIMEOUT_MS = Number(
  process.env.BROWSERLESS_TIMEOUT_MS || 30000
);

const DEFAULT_SESSION_TIMEOUT_MS = Number(
  process.env.BROWSERLESS_SESSION_TIMEOUT_MS || 300000
);

const DEFAULT_DISCOVERY_TIMEOUT_MS = Number(
  process.env.BROWSERLESS_DISCOVERY_TIMEOUT_MS || 15000
);

const DEFAULT_HEALTH_TIMEOUT_MS = Number(
  process.env.BROWSERLESS_HEALTH_TIMEOUT_MS || 15000
);

const DEFAULT_STORAGE_STATE_PATH = path.join(
  __dirname,
  "..",
  "browser-state",
  "ghl-storage-state.json"
);

const AUTH_STATE_ERROR_MESSAGE =
  "GHL authentication state is missing or expired. Re-run authentication setup.";

function normalizeHost(host) {
  return String(host || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^wss?:\/\//i, "")
    .replace(/\/+$/g, "");
}

function getBrowserlessConfig() {
  const host = normalizeHost(process.env.BROWSERLESS_HOST);
  const token = String(process.env.BROWSERLESS_TOKEN || "").trim();
  const ignoreHttpsErrors =
    String(process.env.BROWSERLESS_IGNORE_HTTPS_ERRORS || "").trim().toLowerCase() ===
    "true";

  return {
    host,
    token,
    ignoreHttpsErrors,
  };
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactBrowserlessValue(text) {
  const { token } = getBrowserlessConfig();
  const input = String(text || "");

  if (!token) {
    return input.replace(/([?&]token=)[^&\s]+/gi, "$1[redacted]");
  }

  const tokenPattern = new RegExp(escapeRegExp(token), "g");

  return input
    .replace(tokenPattern, "[redacted]")
    .replace(/([?&]token=)[^&\s]+/gi, "$1[redacted]");
}

function appendQueryParams(urlString, params = {}) {
  const url = new URL(urlString);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function isLoginUrl(value) {
  return /login|signin|auth/i.test(String(value || ""));
}

function getGhlAutomationUrl(locationId) {
  const trimmed = String(locationId || "").trim();

  if (!trimmed) {
    return "https://app.gohighlevel.com/";
  }

  return `https://app.gohighlevel.com/v2/location/${trimmed}/automation/workflows?listTab=all`;
}

function formatBrowserlessError(error) {
  if (!error) {
    return "Browserless connection failed.";
  }

  const message = redactBrowserlessValue(error.message || error);

  if (/Missing BROWSERLESS_HOST|Missing BROWSERLESS_TOKEN/i.test(message)) {
    return message;
  }

  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|socket hang up|Unexpected server response|WebSocket|CDP|browserless|timeout/i.test(message)) {
    return "Browserless remote browser is unavailable or returned an invalid response.";
  }

  return message || "Browserless connection failed.";
}

function buildDiscoveryUrl() {
  const { host, token } = getBrowserlessConfig();

  if (!host) {
    throw new Error("Missing BROWSERLESS_HOST");
  }

  if (!token) {
    throw new Error("Missing BROWSERLESS_TOKEN");
  }

  return `https://${host}/json/version?token=${encodeURIComponent(token)}`;
}

function getSessionTimeoutMs(value = DEFAULT_SESSION_TIMEOUT_MS) {
  const timeoutMs = Number(value);

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_SESSION_TIMEOUT_MS;
  }

  return timeoutMs;
}

function buildWebSocketUrl(pathname = "/", options = {}) {
  const { host, token } = getBrowserlessConfig();
  const normalizedPath =
    pathname && pathname !== "/" ? `/${String(pathname).replace(/^\/+/, "").replace(/\/+$/, "")}` : "/";
  const timeoutMs = getSessionTimeoutMs(options.timeoutMs);

  if (!host) {
    throw new Error("Missing BROWSERLESS_HOST");
  }

  if (!token) {
    throw new Error("Missing BROWSERLESS_TOKEN");
  }

  return appendQueryParams(`wss://${host}${normalizedPath}`, {
    token,
    timeout: timeoutMs,
  });
}

function buildBrowserlessEndpointCandidates(discovery = {}) {
  const candidates = [];
  const seen = new Set();

  const addCandidate = (value) => {
    const candidate = String(value || "").trim();

    if (!candidate || seen.has(candidate)) {
      return;
    }

    seen.add(candidate);
    candidates.push(candidate);
  };

  const timeoutMs = getSessionTimeoutMs(discovery.sessionTimeoutMs);

  addCandidate(buildWebSocketUrl("/", { timeoutMs }));
  addCandidate(buildWebSocketUrl("/chromium", { timeoutMs }));

  const websocketUrl = String(
    discovery.webSocketDebuggerUrl || discovery.websocketDebuggerUrl || ""
  ).trim();

  if (websocketUrl) {
    try {
      const parsed = new URL(websocketUrl);
      addCandidate(
        buildWebSocketUrl(parsed.pathname || "/", {
          timeoutMs,
        })
      );
    } catch {
      // Ignore malformed discovery URLs and continue with the public candidates.
    }
  }

  return candidates;
}

function normalizeStorageStatePath(storageStatePath = DEFAULT_STORAGE_STATE_PATH) {
  const candidate = String(storageStatePath || DEFAULT_STORAGE_STATE_PATH).trim();

  if (!candidate) {
    return DEFAULT_STORAGE_STATE_PATH;
  }

  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(__dirname, "..", candidate);
}

function getBrowserlessStorageStatePath(storageStatePath = DEFAULT_STORAGE_STATE_PATH) {
  return normalizeStorageStatePath(storageStatePath);
}

function logBrowserlessStage(logger, stage, message = "OK") {
  if (typeof logger !== "function") {
    return;
  }

  logger(`${stage}: ${message}`);
}

function stageBrowserlessError(stage, error) {
  const message = formatBrowserlessError(error);
  const wrapped = new Error(`[${stage}] ${message}`);
  wrapped.stage = stage;
  wrapped.cause = error;
  return wrapped;
}

function browserlessStorageStateExists(storageStatePath = DEFAULT_STORAGE_STATE_PATH) {
  const resolvedPath = normalizeStorageStatePath(storageStatePath);

  try {
    const stat = fs.statSync(resolvedPath);

    if (!stat.isFile() || stat.size <= 0) {
      return false;
    }

    const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    return (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.cookies) &&
      Array.isArray(parsed.origins)
    );
  } catch {
    return false;
  }
}

async function saveBrowserlessStorageState(context, storageStatePath = DEFAULT_STORAGE_STATE_PATH) {
  if (!context || typeof context.storageState !== "function") {
    throw new Error("A valid Playwright context is required to save storage state.");
  }

  const resolvedPath = normalizeStorageStatePath(storageStatePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  await context.storageState({ path: resolvedPath, indexedDB: true });

  return {
    path: resolvedPath,
    saved: true,
  };
}

async function createBrowserlessContext(browser, options = {}) {
  const logger = typeof options.logger === "function" ? options.logger : null;
  if (!browser || typeof browser.newContext !== "function") {
    throw stageBrowserlessError(
      "context_create",
      new Error("A valid Playwright browser is required to create a context.")
    );
  }

  const storageStatePath = normalizeStorageStatePath(options.storageStatePath);
  const loadStorageState = options.loadStorageState !== false;
  const contextOptions = { ...(options.contextOptions || {}) };
  const stateExists = browserlessStorageStateExists(storageStatePath);

  if (loadStorageState && stateExists && !contextOptions.storageState) {
    contextOptions.storageState = storageStatePath;
  }

  const context = await browser.newContext(contextOptions).catch((error) => {
    throw stageBrowserlessError("context_create", error);
  });

  logBrowserlessStage(logger, "context_create");

  if (loadStorageState) {
    logBrowserlessStage(
      logger,
      "storage_state_load",
      stateExists ? "loaded" : "missing"
    );
  }

  return {
    context,
    stateExists,
    storageStatePath,
  };
}

function requestJson(urlString, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : DEFAULT_DISCOVERY_TIMEOUT_MS;
  const ignoreHttpsErrors = options.ignoreHttpsErrors === true;
  const method = String(options.method || "GET").toUpperCase();
  const body =
    options.body === undefined || options.body === null
      ? null
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);

  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const request = https.request(
      url,
      {
        method,
        agent: new https.Agent({
          rejectUnauthorized: !ignoreHttpsErrors,
        }),
        headers:
          body === null
            ? undefined
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              },
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");

          if (response.statusCode && response.statusCode >= 400) {
            return reject(
              new Error(
                `Browserless discovery failed with HTTP ${response.statusCode}: ${redactBrowserlessValue(body)}`
              )
            );
          }

          try {
            resolve({
              body: JSON.parse(body || "{}"),
              statusCode: response.statusCode || 0,
            });
          } catch (error) {
            reject(
              new Error(
                `Browserless discovery returned invalid JSON: ${redactBrowserlessValue(
                  body.slice(0, 500)
                )}`
              )
            );
          }
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Browserless discovery timed out."));
    });

    request.on("error", reject);
    if (body !== null) {
      request.write(body);
    }
    request.end();
  });
}

async function withOptionalNodeTlsRelaxation(ignoreHttpsErrors, task) {
  if (!ignoreHttpsErrors) {
    return task();
  }

  const previousValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const previousEmitWarning = process.emitWarning;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  process.emitWarning = () => {};

  try {
    return await task();
  } finally {
    process.emitWarning = previousEmitWarning;
    if (previousValue === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousValue;
    }
  }
}

async function connectBrowserlessEndpoint(endpoint, options = {}) {
  const logger = typeof options.logger === "function" ? options.logger : null;
  const ignoreHttpsErrors =
    options.ignoreHttpsErrors ??
    getBrowserlessConfig().ignoreHttpsErrors === true;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : DEFAULT_CONNECT_TIMEOUT_MS;

  try {
    const browser = await withOptionalNodeTlsRelaxation(ignoreHttpsErrors, () =>
      chromium.connectOverCDP(endpoint, {
        timeout: timeoutMs,
      })
    );

    logBrowserlessStage(logger, "browserless_cdp");
    return browser;
  } catch (error) {
    throw stageBrowserlessError("browserless_cdp", error);
  }
}

async function discoverBrowserless(options = {}) {
  const logger = typeof options.logger === "function" ? options.logger : null;
  const ignoreHttpsErrors =
    options.ignoreHttpsErrors ??
    getBrowserlessConfig().ignoreHttpsErrors === true;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : DEFAULT_DISCOVERY_TIMEOUT_MS;

  try {
    const discoveryUrl = buildDiscoveryUrl();
    const result = await requestJson(discoveryUrl, {
      timeoutMs,
      ignoreHttpsErrors,
    });

    logBrowserlessStage(logger, "browserless_discovery");

    return {
      ...result.body,
      discoveryUrl: redactBrowserlessValue(discoveryUrl),
    };
  } catch (error) {
    throw stageBrowserlessError("browserless_discovery", error);
  }
}

async function openBrowserlessLiveUrl(page, timeoutMs = 600000) {
  const cdp = await page.context().newCDPSession(page);
  const result = await cdp.send("Browserless.liveURL", {
    timeout: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 600000,
  });

  return {
    ...result,
    liveURL: result?.liveURL || result?.url || result?.href || "",
  };
}

async function verifyGhlAuthenticatedPage(page, locationId, timeoutMs = 45000) {
  const targetUrl = getGhlAutomationUrl(locationId);
  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 45000,
  });

  const currentUrl = page.url();
  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  const loginDetected = isLoginUrl(currentUrl) || isLoginUrl(bodyText);

  return {
    currentUrl,
    bodyText,
    loginDetected,
    ghlAuthenticated: !loginDetected && currentUrl.includes("/location/"),
  };
}

async function testBrowserlessGhlAuthStatus(options = {}) {
  const storageStatePath = normalizeStorageStatePath(
    options.storageStatePath
  );
  const stateExists = browserlessStorageStateExists(storageStatePath);
  const locationId =
    String(options.locationId || process.env.GHL_LOCATION_ID || "").trim();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : DEFAULT_CONNECT_TIMEOUT_MS;
  const logger = typeof options.logger === "function" ? options.logger : null;
  let session = null;

  if (!stateExists) {
    return {
      success: false,
      browserless: true,
      stateExists: false,
      ghlAuthenticated: false,
      message: AUTH_STATE_ERROR_MESSAGE,
    };
  }

  try {
    session = await connectBrowserless({
      discovery: options.discovery,
      discoveryTimeoutMs: options.discoveryTimeoutMs,
      ignoreHttpsErrors: options.ignoreHttpsErrors,
      logger,
      loadStorageState: options.loadStorageState,
      storageStatePath,
      timeoutMs,
    });

    const verification = await verifyGhlAuthenticatedPage(
      session.page,
      locationId,
      timeoutMs
    );

    if (!stateExists || !verification.ghlAuthenticated) {
      return {
        success: false,
        browserless: true,
        stateExists,
        ghlAuthenticated: false,
        message: AUTH_STATE_ERROR_MESSAGE,
        url: verification.currentUrl,
      };
    }

    return {
      success: true,
      browserless: true,
      stateExists,
      ghlAuthenticated: true,
      url: verification.currentUrl,
    };
  } catch (error) {
    return {
      success: false,
      browserless: false,
      stateExists,
      ghlAuthenticated: false,
      message: formatBrowserlessError(error),
    };
  } finally {
    await closeBrowserlessSession(session);
  }
}

async function connectBrowserless(options = {}) {
  const logger = typeof options.logger === "function" ? options.logger : null;
  const ignoreHttpsErrors =
    options.ignoreHttpsErrors ??
    getBrowserlessConfig().ignoreHttpsErrors === true;
  const discoveryTimeoutMs = Number.isFinite(Number(options.discoveryTimeoutMs))
    ? Number(options.discoveryTimeoutMs)
    : DEFAULT_DISCOVERY_TIMEOUT_MS;
  const connectTimeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : DEFAULT_CONNECT_TIMEOUT_MS;
  const createPage = options.createPage !== false;
  const loadStorageState = options.loadStorageState !== false;
  const storageStatePath = options.storageStatePath;
  const sessionTimeoutMs = getSessionTimeoutMs(
    options.sessionTimeoutMs ??
      process.env.BROWSERLESS_SESSION_TIMEOUT_MS ??
      DEFAULT_SESSION_TIMEOUT_MS
  );

  const discovery =
    options.discovery ||
    (await discoverBrowserless({
      timeoutMs: discoveryTimeoutMs,
      ignoreHttpsErrors,
      logger,
    }));

  const candidates = buildBrowserlessEndpointCandidates(discovery);
  let lastError = null;

  for (const endpoint of candidates) {
    let browser;

    try {
      browser = await withOptionalNodeTlsRelaxation(ignoreHttpsErrors, () =>
        chromium.connectOverCDP(endpoint, {
          timeout: connectTimeoutMs,
        })
      );

      logBrowserlessStage(logger, "browserless_cdp");

      const { context, stateExists, storageStatePath: resolvedStorageStatePath } =
        await createBrowserlessContext(browser, {
          contextOptions: options.contextOptions,
          logger,
          loadStorageState,
          storageStatePath,
        });

      let page = null;

      if (createPage) {
        page = context.pages()[0] || (await context.newPage());
        logBrowserlessStage(logger, "page_create");
      }

      return {
        browser,
        context,
        page,
        endpoint,
        discovery,
        stateExists,
        storageStatePath: resolvedStorageStatePath,
        sessionTimeoutMs,
      };
    } catch (error) {
      lastError = error;

      if (browser) {
        await browser.disconnect().catch(() => {});
      }
    }
  }

  const wrapped =
    lastError && lastError.stage
      ? lastError
      : stageBrowserlessError("browserless_cdp", lastError);
  throw wrapped;
}

async function closeBrowserlessSession(session) {
  if (!session) {
    return;
  }

  const { page, context, browser } = session;

  if (page) {
    await page.close().catch(() => {});
  }

  if (context) {
    await context.close().catch(() => {});
  }

  if (browser) {
    if (typeof browser.close === "function") {
      await browser.close().catch(() => {});
    } else if (typeof browser.disconnect === "function") {
      await browser.disconnect().catch(() => {});
    }
  }
}

async function testBrowserlessHealth() {
  const discovery = await discoverBrowserless();
  const session = await connectBrowserless({
    discovery,
    createPage: false,
  });

  await closeBrowserlessSession(session);

  return {
    connected: true,
  };
}

async function testBrowserlessConnection(options = {}) {
  const logger = typeof options.logger === "function" ? options.logger : () => {};
  const discovery = await discoverBrowserless({
    timeoutMs: options.discoveryTimeoutMs,
    ignoreHttpsErrors: options.ignoreHttpsErrors,
  });

  logger("Browserless HTTP discovery: OK");

  const session = await connectBrowserless({
    discovery,
    timeoutMs: options.timeoutMs,
    ignoreHttpsErrors: options.ignoreHttpsErrors,
    createPage: false,
  });

  logger("Browserless CDP connection: OK");

  const page = session.context.pages()[0] || (await session.context.newPage());
  page.setDefaultTimeout(Number.isFinite(Number(options.pageTimeoutMs)) ? Number(options.pageTimeoutMs) : 30000);
  page.setDefaultNavigationTimeout(Number.isFinite(Number(options.pageTimeoutMs)) ? Number(options.pageTimeoutMs) : 45000);

  await page.goto("https://example.com", {
    waitUntil: "domcontentloaded",
    timeout: Number.isFinite(Number(options.pageTimeoutMs)) ? Number(options.pageTimeoutMs) : 45000,
  });

  logger("Browserless page test: OK");

  const title = await page.title();
  logger(`Page title: ${title}`);

  await closeBrowserlessSession({
    ...session,
    page,
  });

  return {
    success: true,
    title,
  };
}

module.exports = {
  buildBrowserlessEndpointCandidates,
  browserlessStorageStateExists,
  closeBrowserlessSession,
  createBrowserlessContext,
  connectBrowserlessEndpoint,
  connectBrowserless,
  discoverBrowserless,
  getGhlAutomationUrl,
  getBrowserlessStorageStatePath,
  formatBrowserlessError,
  getBrowserlessConfig,
  openBrowserlessLiveUrl,
  saveBrowserlessStorageState,
  testBrowserlessConnection,
  testBrowserlessGhlAuthStatus,
  testBrowserlessHealth,
  verifyGhlAuthenticatedPage,
  AUTH_STATE_ERROR_MESSAGE,
};
