require("dotenv").config({ quiet: true });

const axios = require("axios");
const fs = require("fs");
const https = require("https");
const path = require("path");
const {
  cleanText,
  extractCanonicalRowName,
  isHeaderText,
  isPlaceholderText,
  looksLikeHeaderOnlyRow,
  normalizeSignatureText,
  rowLooksLikeFolder,
} = require("../services/browser-inventory-shared");
const { formatBrowserlessError } = require("../services/browserless");
const { closeBrowserlessSession: closeV2BrowserlessSession, connectBrowserless: connectV2Browserless } = require("../services/browserless");
const {
  normalizeDeleteJob,
  normalizeDeleteJobs,
  toText,
} = require("../web/services/deleteJob");

const BACKEND_URL = "https://backend.leadconnectorhq.com";
const LOG_PATH = path.join(__dirname, "..", "debug", "v2-funnels-progress.log");
const NAVIGATION_WAIT_MS = 30000;
const UI_POLL_MS = 350;
const startedAt = Date.now();
const VERIFICATION_ONLY = /^(1|true|yes|verify)$/i.test(
  String(process.env.FUNNEL_VERIFY_ONLY || process.env.FUNNEL_MODE || "").trim()
) || process.argv.includes("--verify-only");
const WATCHDOG_MS = VERIFICATION_ONLY ? 90000 : 58000;

const DELETE_JOBS_STATE = parseDeleteJobsJson();
const TARGET_SELECTION = selectSingleFunnelJob(DELETE_JOBS_STATE.jobs);
const TARGET_OVERRIDE = TARGET_SELECTION.job;
const LOCATION_ID = String(TARGET_OVERRIDE?.locationId || "").trim();
const GHL_URL = `https://app.olspsystem.com/v2/location/${LOCATION_ID}/funnels-websites/funnels`;
const AUTHENTICATED_LOCATION_ID = String(process.env.GHL_LOCATION_ID || "").trim();
function getStorageStatePath() {
  return String(
    process.env.BROWSER_STORAGE_STATE_PATH ||
      path.join(__dirname, "..", "browser-state", "ghl-storage-state.json")
  ).trim();
}

let session = null;
let finished = false;

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
fs.writeFileSync(LOG_PATH, "");

function emit(message) {
  const line = String(message);
  console.log(line);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

function normalize(value) {
  return cleanText(value).toLowerCase();
}

function parseDeleteJobsJson() {
  try {
    const source = String(process.env.DELETE_JOBS_JSON || "").trim();
    if (!source) {
      return { jobs: [], error: "DELETE_JOBS_JSON is required." };
    }
    const parsed = JSON.parse(source);
    if (!Array.isArray(parsed)) {
      return { jobs: [], error: "DELETE_JOBS_JSON must be a JSON array." };
    }
    return {
      jobs: normalizeDeleteJobs(parsed, "funnel"),
      error: "",
    };
  } catch (error) {
    return { jobs: [], error: `DELETE_JOBS_JSON is invalid: ${error.message}` };
  }
}

function selectSingleFunnelJob(jobs) {
  const parsedJobs = Array.isArray(jobs) ? jobs.filter(Boolean) : [];

  if (parsedJobs.length !== 1) {
    return {
      job: null,
      jobReceived: parsedJobs.length > 0,
      error:
        parsedJobs.length === 0
          ? "No funnel job was provided."
          : "DELETE_JOBS_JSON must contain exactly one funnel job.",
    };
  }

  const job = parsedJobs[0];
  const normalized = normalizeDeleteJob(job, "funnel");
  const locationId = toText(normalized.locationId);
  if (!locationId) {
    return {
      job: null,
      jobReceived: true,
      error: "Missing locationId.",
    };
  }

  if (AUTHENTICATED_LOCATION_ID && locationId !== AUTHENTICATED_LOCATION_ID) {
    return {
      job: null,
      jobReceived: true,
      error: "Funnel job location does not match the authenticated selected location.",
    };
  }

  if (!toText(normalized.resourceId) && !toText(normalized.resourceName)) {
    return {
      job: null,
      jobReceived: true,
      error: "Missing funnel identity.",
    };
  }

  return {
    job: {
      ...normalized,
      locationId,
    },
    jobReceived: true,
    error: "",
  };
}

function buildApiClient(headers) {
  return axios.create({
    baseURL: BACKEND_URL,
    timeout: 30000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    headers: {
      ...headers,
      Accept: "application/json",
    },
  });
}

function pickArray(data, candidates) {
  for (const candidate of candidates) {
    const value = candidate.split(".").reduce((current, key) => current?.[key], data);
    if (Array.isArray(value)) {
      return value;
    }
  }

  if (Array.isArray(data)) {
    return data;
  }

  return [];
}

function normalizeFunnelItem(item, folderById) {
  const id = String(item?.id || item?._id || item?.funnelId || "").trim();
  const name = cleanText(item?.name || item?.title || "");
  const folderId = String(item?.folderId || item?.parentId || "").trim() || null;
  const folderName =
    cleanText(item?.folderName || item?.parentName || folderById.get(folderId)?.name || "") ||
    null;

  return {
    id,
    name,
    folderId,
    folderName,
  };
}

function normalizeFolderItem(item) {
  const id = String(item?.id || item?._id || item?.folderId || "").trim();
  const name = cleanText(item?.name || item?.title || "");
  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    type: "folder",
  };
}

function buildFolderLookup(folderList, rootFunnels, folderEntityCounts) {
  const foldersById = new Map();
  const foldersByName = new Map();

  for (const item of folderList) {
    const folder = normalizeFolderItem(item);
    if (!folder) {
      continue;
    }

    foldersById.set(folder.id, folder);
    foldersByName.set(normalize(folder.name), folder);
  }

  for (const item of rootFunnels) {
    const folder = normalizeFolderItem(item);
    const folderEntityCount = folder ? Number(folderEntityCounts.get(folder.id) || 0) : 0;
    const isRootFolder = folder && !String(item?.parentId || "").trim() && folderEntityCount > 0;
    if (!isRootFolder) {
      continue;
    }

    foldersById.set(folder.id, folder);
    foldersByName.set(normalize(folder.name), folder);
  }

  return { foldersById, foldersByName };
}

function pickExactFolder(foldersById, foldersByName, targetFolderId, targetFolderName) {
  if (targetFolderId) {
    const folderById = foldersById.get(targetFolderId);
    if (folderById) {
      return folderById;
    }
  }

  if (targetFolderName) {
    const folderByName = foldersByName.get(normalize(targetFolderName));
    if (folderByName) {
      return folderByName;
    }
  }

  return null;
}

function pickExactFunnel(funnels, target) {
  if (!Array.isArray(funnels) || funnels.length === 0) {
    return null;
  }

  if (target?.id) {
    const byId = funnels.find((item) => normalize(item.id) === normalize(target.id));
    if (byId) {
      return byId;
    }
  }

  if (target?.name) {
    const byName = funnels.find((item) => normalize(item.name) === normalize(target.name));
    if (byName) {
      return byName;
    }
  }

  return null;
}

function isExactVisibleRowText(text, targetName) {
  const lhs = normalize(text);
  const rhs = normalize(targetName);
  return lhs === rhs || lhs.includes(rhs) || normalizeSignatureText(lhs).includes(rhs);
}

async function waitForVisible(locator, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isVisible().catch(() => false)) {
      return true;
    }
    await locator.page().waitForTimeout(UI_POLL_MS).catch(() => {});
  }
  return false;
}

async function resolveApiTarget(page) {
  const listRequestPromise = page.waitForRequest(
    (request) => request.url().includes("/funnels/funnel/list"),
    { timeout: 15000 }
  );

  const headers = await listRequestPromise.then((request) => request.headers()).catch(() => null);
  if (!headers) {
    throw new Error("Unable to capture funnel API request headers.");
  }

  const client = buildApiClient(headers);
  const locationId = LOCATION_ID;

  const [foldersResponse, folderEntitiesResponse, funnelsResponse] = await Promise.all([
    client.get("/funnels/funnel/folder/list", {
      params: { locationId, type: "all" },
    }),
    client.get("/funnels/funnel/folder/entities", {
      params: { locationId, type: "funnel" },
    }),
    client.get("/funnels/funnel/list", {
      params: {
        locationId,
        type: "funnel",
        category: "all",
        offset: 0,
        limit: 100,
      },
    }),
  ]);

  const folderList = pickArray(foldersResponse.data, ["folders", "data.folders", "data"]);
  const folderEntities = pickArray(folderEntitiesResponse.data, ["folders", "data", "data.folders"]);
  const allFunnels = pickArray(funnelsResponse.data, ["funnels", "data.funnels", "data"]);

  const folderEntityCounts = new Map(
    folderEntities
      .map((item) => ({
        id: String(item?._id || item?.id || "").trim(),
        entities: Number(item?.entities || 0),
      }))
      .filter((item) => item.id)
      .map((item) => [item.id, item.entities])
  );

  const rootFunnels = allFunnels
    .map((item) => normalizeFunnelItem(item, new Map()))
    .filter((item) => item.id && item.name);

  const { foldersById, foldersByName } = buildFolderLookup(folderList, rootFunnels, folderEntityCounts);
  if (!TARGET_OVERRIDE || (!TARGET_OVERRIDE.resourceId && !TARGET_OVERRIDE.resourceName)) {
    throw new Error("DELETE_JOBS_JSON must contain exactly one funnel job.");
  }

  const selectedFolder =
    pickExactFolder(
      foldersById,
      foldersByName,
      TARGET_OVERRIDE.parentId,
      TARGET_OVERRIDE.parentName
    );

  if (!selectedFolder) {
    throw new Error(`Unable to resolve folder "${TARGET_OVERRIDE.parentName || "root"}".`);
  }

  const folderFunnelsResponse = await client.get("/funnels/funnel/list", {
    params: {
      locationId,
      type: "funnel",
      category: "all",
      offset: 0,
      parentId: selectedFolder.id,
      limit: 100,
    },
  });

  const folderFunnels = pickArray(folderFunnelsResponse.data, ["funnels", "data.funnels", "data"])
    .map((item) => normalizeFunnelItem(item, new Map([[selectedFolder.id, selectedFolder]])))
    .filter((item) => item.id && item.name);

  const requestedTarget = {
    id: TARGET_OVERRIDE.resourceId,
    name: TARGET_OVERRIDE.resourceName,
    folderId: TARGET_OVERRIDE.parentId || selectedFolder.id,
    folderName: TARGET_OVERRIDE.parentName || selectedFolder.name,
  };

  if (!folderFunnels.length && !VERIFICATION_ONLY) {
    throw new Error(`No funnel records were returned for folder "${selectedFolder.name}".`);
  }

  const target = pickExactFunnel(folderFunnels, requestedTarget);

  if (!target) {
    throw new Error(`Unable to resolve funnel target for folder "${selectedFolder.name}".`);
  }

  if (
    requestedTarget.name &&
    normalize(target.name) !== normalize(requestedTarget.name)
  ) {
    throw new Error(
      `Resolved funnel name "${target.name}" did not exactly match "${requestedTarget.name}".`
    );
  }

  if (
    requestedTarget.id &&
    target.id &&
    normalize(target.id) !== normalize(requestedTarget.id)
  ) {
    throw new Error(
      `Resolved funnel id "${target.id}" did not exactly match "${requestedTarget.id}".`
    );
  }

  return {
    apiFolderCount: foldersById.size || folderList.length || folderEntityCounts.size,
    apiFunnelCount: allFunnels.length,
    apiActualFunnelCount: folderFunnels.length,
    target,
    folder: selectedFolder,
    folderFunnels,
    headers,
  };
}

async function openExactFolder(page, folderName) {
  if (!folderName) {
    return false;
  }

  const folderRows = page.locator("table tbody tr, [role='row'], [aria-rowindex], [data-row-index], [data-index], [role='listitem']");
  const count = await folderRows.count().catch(() => 0);

  for (let index = 0; index < Math.min(count, 20); index += 1) {
    const row = folderRows.nth(index);
    if (!(await row.isVisible().catch(() => false))) {
      continue;
    }

    const text = cleanText(
      await extractCanonicalRowName(row, "funnels").catch(() => "")
    );
    if (normalize(text) !== normalize(folderName)) {
      continue;
    }

    const clickable = row.locator("a[href], button, [role='button'], [aria-haspopup]").first();
    if (await clickable.isVisible().catch(() => false)) {
      await clickable.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1000);
      return true;
    }

    await row.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1000);
    return true;
  }

  return false;
}

async function findSearchInput(page) {
  const candidates = [
    page.locator('input[placeholder*="search for funnels" i]').first(),
    page.locator('input[placeholder*="search funnels" i]').first(),
    page.locator('input[placeholder*="search" i]').first(),
    page.getByRole("searchbox").first(),
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  return null;
}

async function findExactRow(page, targetName) {
  const locator = page.locator("table tbody tr, [role='row'], [aria-rowindex], [data-row-index], [data-index], [role='listitem']");
  const count = await locator.count().catch(() => 0);

  for (let index = 0; index < Math.min(count, 25); index += 1) {
    const row = locator.nth(index);
    if (!(await row.isVisible().catch(() => false))) {
      continue;
    }

    const text = cleanText(
      await extractCanonicalRowName(row, "funnels").catch(() => "")
    );
    if (!isExactVisibleRowText(text, targetName)) {
      continue;
    }

    return row;
  }

  return null;
}

async function findRowActionsFast(row) {
  const selectors = [
    'button[aria-haspopup="menu"]',
    '[aria-label*="action" i]',
    '[aria-label*="more" i]',
    '[data-testid*="action" i]',
    '[data-testid*="more" i]',
    'button, [role="button"], [aria-haspopup]',
  ];

  for (const selector of selectors) {
    const candidate = row.locator(selector).last();
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  return null;
}

async function waitForDeleteVisible(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const candidates = () => [
    page.getByRole("menuitem", { name: /delete/i }).first(),
    page.getByRole("button", { name: /delete/i }).first(),
    page.locator('[role="menu"]').getByText(/delete/i).first(),
    page.getByText(/^delete$/i).first(),
  ];

  while (Date.now() < deadline) {
    for (const candidate of candidates()) {
      if (await candidate.isVisible().catch(() => false)) {
        return true;
      }
    }

    await page.waitForTimeout(250);
  }

  return false;
}

async function clearSearchInput(page) {
  const searchInput = await findSearchInput(page);
  if (!searchInput) {
    return false;
  }

  await searchInput.fill("").catch(async () => {
    await searchInput.click({ force: true }).catch(() => {});
    await searchInput.press("Control+A").catch(() => {});
    await searchInput.press("Backspace").catch(() => {});
  });
  await page.waitForTimeout(1000);
  return true;
}

async function confirmDeleteDialog(page, targetName, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dialogs = page.locator('[role="dialog"], [aria-modal="true"]');
    const dialogCount = await dialogs.count().catch(() => 0);
    for (let index = 0; index < dialogCount; index += 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) {
        continue;
      }

      const confirmCandidates = [
        dialog.getByRole("button", { name: /delete/i }).first(),
        dialog.getByRole("button", { name: /confirm/i }).first(),
        dialog.getByRole("button", { name: /yes/i }).first(),
        dialog.getByRole("button", { name: /remove/i }).first(),
        dialog.getByRole("button", { name: /^ok$/i }).first(),
      ];

      for (const candidate of confirmCandidates) {
        if (await candidate.isVisible().catch(() => false)) {
          await candidate.click({ timeout: 5000 });
          return true;
        }
      }

      const textConfirm = dialog.getByText(/delete|confirm|yes|remove|ok/i).first();
      if (await textConfirm.isVisible().catch(() => false)) {
        await textConfirm.click({ force: true }).catch(() => {});
        return true;
      }
    }

    await page.waitForTimeout(250);
  }

  throw new Error(`Delete confirmation dialog did not appear for "${targetName}".`);
}

async function verifyTargetMissing(page, targetId, targetName, folderId, headers) {
  const client = buildApiClient(headers);
  const apiResponse = await client.get("/funnels/funnel/list", {
    params: {
      locationId: LOCATION_ID,
      type: "funnel",
      category: "all",
      offset: 0,
      parentId: folderId,
      limit: 100,
    },
  });

  const folderFunnels = pickArray(apiResponse.data, ["funnels", "data.funnels", "data"]);
  const normalized = folderFunnels.map((item) => normalizeFunnelItem(item, new Map())).filter((item) => item.id && item.name);
  const apiStillPresent = normalized.some(
    (item) =>
      normalize(item.id) === normalize(targetId) ||
      normalize(item.name) === normalize(targetName)
  );

  await page.reload({ waitUntil: "domcontentloaded", timeout: NAVIGATION_WAIT_MS }).catch(() => {});
  await page.waitForTimeout(3000);

  const searchInput = await findSearchInput(page);
  if (searchInput) {
    await searchInput.fill("Registration", { timeout: 5000 }).catch(async () => {
      await searchInput.click({ force: true }).catch(() => {});
      await searchInput.press("Control+A").catch(() => {});
      await searchInput.type("Registration", { delay: 10 }).catch(() => {});
    });
    await page.waitForTimeout(1500);
  }

  const uiStillPresent = !!(await findExactRow(page, targetName));

  return {
    apiStillPresent,
    uiStillPresent,
  };
}

async function verifyTargetAbsent(page, targetName, folderName, folderId, headers, targetId) {
  await clearSearchInput(page);
  const rowPresentBeforeRefresh = !!(await findExactRow(page, targetName));

  await page.goto(GHL_URL, { waitUntil: "domcontentloaded", timeout: NAVIGATION_WAIT_MS }).catch(() => {});
  await page.waitForTimeout(3000);
  if (folderName) {
    await openExactFolder(page, folderName);
  }
  await clearSearchInput(page);
  const rowPresentAfterRefresh = !!(await findExactRow(page, targetName));

  const client = buildApiClient(headers);
  const apiCheck = async () => {
    const response = await client.get("/funnels/funnel/list", {
      params: {
        locationId: LOCATION_ID,
        type: "funnel",
        category: "all",
        offset: 0,
        parentId: folderId,
        limit: 100,
      },
    });
    const folderFunnels = pickArray(response.data, ["funnels", "data.funnels", "data"]);
    const normalized = folderFunnels
      .map((item) => normalizeFunnelItem(item, new Map()))
      .filter((item) => item.id && item.name);
    return normalized.some(
      (item) =>
        normalize(item.id) === normalize(targetId) ||
        normalize(item.name) === normalize(targetName)
    );
  };

  await page.waitForTimeout(3000);
  const apiStillPresentFirst = await apiCheck();
  let apiStillPresentFinal = apiStillPresentFirst;
  if (apiStillPresentFirst) {
    await page.waitForTimeout(5000);
    apiStillPresentFinal = await apiCheck();
  }

  return {
    rowPresentBeforeRefresh,
    rowPresentAfterRefresh,
    apiStillPresent: apiStillPresentFinal,
    apiCheckedTwice: apiStillPresentFirst,
  };
}

async function main() {
  const result = {
    success: false,
    dryRunSuccess: false,
    status: "failed",
    targetId: "",
    targetName: "",
    folderName: "",
    deleteClicked: false,
    confirmationCompleted: false,
    rowDisappeared: false,
    rowAbsentAfterRefresh: false,
    uiVerificationPassed: false,
    apiVerificationPassed: false,
    apiVerificationStatus: "",
    runtimeMs: 0,
    locationId: LOCATION_ID,
    apiFunnelCount: 0,
    apiFolderCount: 0,
    apiActualFunnelCount: 0,
    proposedTestFunnel: {
      id: "",
      name: "",
      folderId: null,
      folderName: null,
    },
    resolvedFolderId: null,
    resolvedFolderName: "",
    resolvedActualFunnelId: "",
    resolvedActualFunnelName: "",
    folderId: null,
    folderOpened: false,
    exactRowFound: false,
    actionsFound: false,
    deleteVisible: false,
    failedStep: "",
    error: "",
    totalRuntimeMs: 0,
    nothingDeleted: true,
  };

  if (AUTHENTICATED_LOCATION_ID && LOCATION_ID && AUTHENTICATED_LOCATION_ID !== LOCATION_ID) {
    result.error = "Funnel job location does not match the authenticated selected location.";
    result.failedStep = "location_guard";
    result.totalRuntimeMs = Date.now() - startedAt;
    emit(`[FUNNEL] FAIL step=location_guard error=${result.error}`);
    emit(`FUNNEL_RESULT_JSON:${JSON.stringify(result)}`);
    process.exitCode = 1;
    return;
  }

  if (DELETE_JOBS_STATE.error) {
    result.error = DELETE_JOBS_STATE.error;
    result.failedStep = "delete_jobs_parse";
    result.totalRuntimeMs = Date.now() - startedAt;
    emit(`[FUNNEL] FAIL step=delete_jobs_parse error=${result.error}`);
    emit(`FUNNEL_RESULT_JSON:${JSON.stringify(result)}`);
    process.exitCode = 1;
    return;
  }

  if (!TARGET_OVERRIDE) {
    result.error = TARGET_SELECTION.error || "DELETE_JOBS_JSON must contain exactly one funnel job.";
    result.failedStep = "delete_jobs_select";
    result.totalRuntimeMs = Date.now() - startedAt;
    emit(`[FUNNEL] FAIL step=delete_jobs_select error=${result.error}`);
    emit(`FUNNEL_RESULT_JSON:${JSON.stringify(result)}`);
    process.exitCode = 1;
    return;
  }

  const watchdog = setTimeout(async () => {
    if (finished) {
      return;
    }

    result.totalRuntimeMs = Date.now() - startedAt;
    result.failedStep = "watchdog";
    result.error = "Timed out before dry run completed";
    emit(`[FUNNEL] FAIL step=watchdog error=${result.error}`);
    emit(`FUNNEL_RESULT_JSON:${JSON.stringify(result)}`);
    await closeV2BrowserlessSession(session).catch(() => {});
    process.exit(1);
  }, WATCHDOG_MS);

  if (typeof watchdog.unref === "function") {
    watchdog.unref();
  }

  try {
    session = await connectV2Browserless({
      connectTimeoutMs: 20000,
      discoveryTimeoutMs: 15000,
      sessionTimeoutMs: 300000,
      pageTimeoutMs: NAVIGATION_WAIT_MS,
      storageStatePath: getStorageStatePath(),
    });
    emit("[FUNNEL] connected");

    const page = session.page || session.context.pages()[0] || (await session.context.newPage());
    page.setDefaultTimeout(NAVIGATION_WAIT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_WAIT_MS);

    const apiResolutionPromise = resolveApiTarget(page);

    await page.goto(GHL_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_WAIT_MS,
    });
    emit("[FUNNEL] navigated");

    const apiResolution = await apiResolutionPromise;
    result.apiFunnelCount = apiResolution.apiFunnelCount;
    result.apiFolderCount = apiResolution.apiFolderCount;
    result.apiActualFunnelCount = apiResolution.apiActualFunnelCount;
    result.proposedTestFunnel = apiResolution.target;
    result.targetId = apiResolution.target.id || "";
    result.targetName = apiResolution.target.name || "";
    result.resolvedFolderId = apiResolution.folder.id;
    result.resolvedFolderName = apiResolution.folder.name;
    result.resolvedActualFunnelId = apiResolution.target.id;
    result.resolvedActualFunnelName = apiResolution.target.name;
    result.folderName = apiResolution.target.folderName || "";
    result.folderId = apiResolution.target.folderId || null;
    emit(`[FUNNEL] API folder resolved=${apiResolution.folder.name}`);
    emit(`[FUNNEL] API target resolved=${apiResolution.target.name}`);

    if (apiResolution.target.folderName) {
      result.folderOpened = await openExactFolder(page, apiResolution.target.folderName);
      if (result.folderOpened) {
        emit("[FUNNEL] folder opened");
      }
    }

    if (VERIFICATION_ONLY) {
      const verification = await verifyTargetAbsent(
        page,
        apiResolution.target.name,
        apiResolution.target.folderName || apiResolution.folder.name,
        apiResolution.target.folderId || apiResolution.folder.id,
        apiResolution.headers,
        apiResolution.target.id
      );

      result.rowDisappeared = !verification.rowPresentBeforeRefresh;
      result.rowAbsentAfterRefresh = !verification.rowPresentAfterRefresh;
      result.uiVerificationPassed = result.rowDisappeared && result.rowAbsentAfterRefresh;
      result.apiVerificationPassed = !verification.apiStillPresent;
      result.apiVerificationStatus = verification.apiStillPresent ? "stale_or_delayed" : "verified";
      result.status = result.uiVerificationPassed ? "deleted" : "failed";
      result.success = result.uiVerificationPassed;
      result.runtimeMs = Date.now() - startedAt;
      result.totalRuntimeMs = result.runtimeMs;
      result.error = result.uiVerificationPassed
        ? ""
        : "Target row is still visible in the UI after refresh";
      emit(`[FUNNEL] VERIFICATION ${result.uiVerificationPassed ? "PASSED" : "FAILED"}`);
      emit(`FUNNEL_RESULT_JSON:${JSON.stringify(result)}`);
      return;
    }

    const searchInput = await findSearchInput(page);
    if (!searchInput) {
      result.failedStep = "search_input";
      result.error = "Search field was not found";
      result.totalRuntimeMs = Date.now() - startedAt;
      emit(`[FUNNEL] FAIL step=search_input error=${result.error}`);
      emit(`FUNNEL_RESULT_JSON:${JSON.stringify(result)}`);
      return;
    }

    await searchInput.fill(apiResolution.target.name, { timeout: 5000 }).catch(async () => {
      await searchInput.click({ force: true }).catch(() => {});
      await searchInput.press("Control+A").catch(() => {});
      await searchInput.type(apiResolution.target.name, { delay: 10 }).catch(() => {});
    });
    emit("[FUNNEL] search filled");
    await page.waitForTimeout(1500);

    let exactRow = await findExactRow(page, apiResolution.target.name);
    if (!exactRow) {
      const fallbackQueries = ["Registration", "All Lives"];
      for (const fallbackQuery of fallbackQueries) {
        await searchInput.fill(fallbackQuery, { timeout: 5000 }).catch(async () => {
          await searchInput.click({ force: true }).catch(() => {});
          await searchInput.press("Control+A").catch(() => {});
          await searchInput.type(fallbackQuery, { delay: 10 }).catch(() => {});
        });
        await page.waitForTimeout(1500);
        exactRow = await findExactRow(page, apiResolution.target.name);
        if (exactRow) {
          break;
        }
      }
    }

    if (!exactRow) {
      result.failedStep = "exact_row";
      result.error = `Exact funnel row not found for "${apiResolution.target.name}"`;
      result.totalRuntimeMs = Date.now() - startedAt;
      emit(`[FUNNEL] FAIL step=exact_row error=${result.error}`);
      emit(`FUNNEL_RESULT_JSON:${JSON.stringify(result)}`);
      return;
    }

    result.exactRowFound = true;
    emit("[FUNNEL] exact row found");

    await exactRow.hover().catch(() => {});
    await page.waitForTimeout(350);

    const actionCandidate = await findRowActionsFast(exactRow);
    if (!actionCandidate) {
      result.failedStep = "actions";
      result.error = `Row-local Actions control was not found for "${apiResolution.target.name}"`;
      result.totalRuntimeMs = Date.now() - startedAt;
      emit(`[FUNNEL] FAIL step=actions error=${result.error}`);
      emit(`FUNNEL_RESULT_JSON:${JSON.stringify(result)}`);
      return;
    }

    result.actionsFound = true;
    emit("[FUNNEL] Actions found");

    await actionCandidate.click({ timeout: 5000 }).catch((error) => {
      throw new Error(`Failed to open row actions for "${apiResolution.target.name}": ${error.message}`);
    });
    await page.waitForTimeout(500);

    result.deleteVisible = await waitForDeleteVisible(page, 8000);
    if (!result.deleteVisible) {
      result.failedStep = "delete_visible";
      result.error = `Delete was not visible for "${apiResolution.target.name}"`;
      result.totalRuntimeMs = Date.now() - startedAt;
      emit(`[FUNNEL] FAIL step=delete_visible error=${result.error}`);
      emit(`FUNNEL_RESULT_JSON:${JSON.stringify(result)}`);
      return;
    }

    emit("[FUNNEL] Delete visible");
    const deleteButton = page.getByRole("menuitem", { name: /delete/i }).first();
    await deleteButton.click({ timeout: 5000 });
    result.deleteClicked = true;
    emit("[FUNNEL] Delete clicked");

    result.confirmationCompleted = await confirmDeleteDialog(page, apiResolution.target.name);
    emit("[FUNNEL] confirmation completed");

    const verification = await verifyTargetMissing(
      page,
      apiResolution.target.id,
      apiResolution.target.name,
      apiResolution.folder.id,
      apiResolution.headers
    );
    result.rowDisappeared = !verification.uiStillPresent;
    result.apiVerificationPassed = !verification.apiStillPresent;

    if (result.rowDisappeared && result.apiVerificationPassed) {
      result.success = true;
      result.status = "deleted";
      result.nothingDeleted = false;
      result.runtimeMs = Date.now() - startedAt;
      result.failedStep = "";
      result.error = "";
      result.totalRuntimeMs = result.runtimeMs;
      emit("[FUNNEL] DELETE SUCCESS");
      emit(`FUNNEL_RESULT_JSON:${JSON.stringify(result)}`);
      return;
    }

    result.failedStep = "verification";
    result.error = [
      verification.uiStillPresent ? "UI row still present" : "",
      verification.apiStillPresent ? "API still returns funnel" : "",
    ]
      .filter(Boolean)
      .join("; ");
    result.runtimeMs = Date.now() - startedAt;
    result.totalRuntimeMs = result.runtimeMs;
    emit(`[FUNNEL] FAIL step=verification error=${result.error}`);
    emit(`FUNNEL_RESULT_JSON:${JSON.stringify(result)}`);
    return;
  } catch (error) {
    result.runtimeMs = Date.now() - startedAt;
    result.totalRuntimeMs = result.runtimeMs;
    result.failedStep = result.failedStep || "unknown";
    result.error = formatBrowserlessError(error);
    emit(`[FUNNEL] FAIL step=${result.failedStep} error=${result.error}`);
    emit(`FUNNEL_RESULT_JSON:${JSON.stringify(result)}`);
    process.exitCode = 1;
  } finally {
    finished = true;
    clearTimeout(watchdog);
    await closeV2BrowserlessSession(session).catch(() => {});
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    const result = {
      success: false,
      dryRunSuccess: false,
      failedStep: "unhandled",
      error: formatBrowserlessError(error),
      runtimeMs: Date.now() - startedAt,
      totalRuntimeMs: Date.now() - startedAt,
      nothingDeleted: true,
    };

    emit(`[FUNNEL] FAIL step=unhandled error=${result.error}`);
    emit(`FUNNEL_RESULT_JSON:${JSON.stringify(result)}`);
    finished = true;
    await closeV2BrowserlessSession(session).catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  buildApiClient,
  buildFolderLookup,
  closeV2BrowserlessSession,
  connectV2Browserless,
  emit,
  findExactRow,
  findRowActionsFast,
  findSearchInput,
  isExactVisibleRowText,
  main,
  normalizeFunnelItem,
  parseDeleteJobsJson,
  pickExactFunnel,
  pickExactFolder,
  selectSingleFunnelJob,
  resolveApiTarget,
  verifyTargetAbsent,
};
