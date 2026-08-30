require("dotenv").config({ quiet: true });

const axios = require("axios");
const path = require("path");
const https = require("https");
const { chromium } = require("playwright");
const {
  closeBrowserlessSession,
  connectBrowserless,
  browserlessStorageStateExists,
  formatBrowserlessError,
  saveBrowserlessStorageState,
  verifyGhlAuthenticatedPage,
} = require("../services/browserless");

const LOCATION_ID = String(process.env.GHL_LOCATION_ID || "").trim();
const FOLDER_NAME = String(process.env.CUSTOM_VALUE_FOLDER_NAME || "").trim();
const GHL_TOKEN = String(process.env.GHL_TOKEN || "").trim();
function getStorageStatePath() {
  return String(
    process.env.BROWSER_STORAGE_STATE_PATH ||
      path.join(
        __dirname,
        "..",
        "browser-state",
        "ghl-storage-state.json"
      )
  ).trim();
}
const CUSTOM_VALUES_BASE_URL = "https://services.leadconnectorhq.com";
const CUSTOM_VALUES_API_VERSION = "2021-07-28";
const CUSTOM_VALUES_ORIGIN = "https://app.olspsystem.com";
const CUSTOM_VALUES_BROWSER_MODE = String(
  process.env.CUSTOM_VALUES_BROWSER_MODE || ""
)
  .trim()
  .toLowerCase();

function parseItems() {
  try {
    const value = JSON.parse(process.env.CUSTOM_VALUES || "[]");
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item) => ({
        name: String(item?.name || item?.key || "").trim(),
        value: String(item?.value || "").trim(),
      }))
      .filter((item) => item.name && item.value);
  } catch {
    return [];
  }
}

function normalize(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function isVisible(locator) {
  return locator.isVisible().catch(() => false);
}

async function firstVisible(candidates) {
  for (const candidate of candidates) {
    if (await isVisible(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function clickByText(page, patterns) {
  const candidates = [];
  for (const pattern of patterns) {
    candidates.push(
      page.getByRole("button", { name: pattern }).last(),
      page.getByRole("link", { name: pattern }).last(),
      page.getByText(pattern).last()
    );
  }

  const target = await firstVisible(candidates);
  if (!target) {
    throw new Error(`Unable to find control matching: ${patterns.map((pattern) => String(pattern)).join(", ")}`);
  }

  await target.click({ force: true });
}

async function fillFirst(page, locators, value) {
  for (const locator of locators) {
    if (await isVisible(locator)) {
      await locator.fill(value, { timeout: 5000 }).catch(async () => {
        await locator.click({ force: true }).catch(() => {});
        await locator.press("Control+A").catch(() => {});
        await locator.type(value, { delay: 10 }).catch(() => {});
      });
      return true;
    }
  }
  return false;
}

async function waitForBodyText(page, needle, timeoutMs = 15000) {
  const text = normalize(needle);
  await page.waitForFunction(
    (expected) =>
      String(document.body?.innerText || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
        .includes(expected),
    text,
    { timeout: timeoutMs }
  );
}

async function openCustomValuesPage(page, locationId) {
  const settingsUrl = `${CUSTOM_VALUES_ORIGIN}/v2/location/${locationId}/settings/custom_values`;
  await page.goto(settingsUrl, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function currentBodyText(page) {
  return normalize(await page.locator("body").innerText().catch(() => ""));
}

function logFolderStep(step, message = "") {
  const suffix = message ? ` ${message}` : "";
  console.log(`[CUSTOM VALUES] FOLDER ${step}${suffix}`);
}

function createCustomValuesClient(token) {
  return axios.create({
    baseURL: CUSTOM_VALUES_BASE_URL,
    timeout: 30000,
    httpsAgent: new https.Agent({
      rejectUnauthorized: false,
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Version: CUSTOM_VALUES_API_VERSION,
    },
  });
}

function extractCustomValues(data) {
  if (Array.isArray(data?.customValues)) {
    return data.customValues;
  }

  if (Array.isArray(data?.values)) {
    return data.values;
  }

  if (Array.isArray(data?.data?.customValues)) {
    return data.data.customValues;
  }

  if (Array.isArray(data?.data?.values)) {
    return data.data.values;
  }

  if (Array.isArray(data)) {
    return data;
  }

  return [];
}

function matchesCustomValue(item, target) {
  return (
    normalize(item?.name) === normalize(target.name) &&
    String(item?.value ?? "") === String(target.value ?? "")
  );
}

async function listCustomValues(token, locationId) {
  const client = createCustomValuesClient(token);
  const response = await client.get(`/locations/${locationId}/customValues`);
  return extractCustomValues(response.data);
}

async function ensureCustomValueApi(token, locationId, item) {
  const client = createCustomValuesClient(token);
  const before = await listCustomValues(token, locationId);

  if (before.some((value) => matchesCustomValue(value, item))) {
    return "existing";
  }

  try {
    await client.post(`/locations/${locationId}/customValues`, {
      name: item.name,
      value: item.value,
    });
  } catch (error) {
    const afterError = await listCustomValues(token, locationId).catch(() => []);
    if (afterError.some((value) => matchesCustomValue(value, item))) {
      return "existing";
    }
    throw error;
  }

  const after = await listCustomValues(token, locationId);
  if (after.some((value) => matchesCustomValue(value, item))) {
    return "created";
  }

  throw new Error(`Custom value "${item.name}" was not found after create.`);
}

async function collectCustomValuesSignals(scope) {
  const selectors = [
    {
      label: "Custom values",
      locator: scope.getByText(/^Custom values$/i).first(),
    },
    {
      label: "Add folder",
      locator: scope.getByRole("button", { name: /add folder/i }).first(),
    },
    {
      label: "Add custom value",
      locator: scope.getByRole("button", { name: /add custom value/i }).first(),
    },
    {
      label: "All values",
      locator: scope.getByText(/^All values$/i).first(),
    },
    {
      label: "Folders",
      locator: scope.getByText(/^Folders$/i).first(),
    },
    {
      label: "Search values",
      locator: scope.locator('input[placeholder*="Search values" i]').first(),
    },
  ];

  const found = [];
  for (const { label, locator } of selectors) {
    if (await isVisible(locator)) {
      found.push(label);
    }
  }

  return found;
}

async function verifyCustomValuesPage(page) {
  const scopes = [page, ...page.frames()];
  const deadline = Date.now() + 30000;
  let bestSignals = [];
  let bestScopeUrl = "";

  while (Date.now() < deadline) {
    for (const scope of scopes) {
      const foundSignals = await collectCustomValuesSignals(scope);
      if (foundSignals.length > bestSignals.length) {
        bestSignals = foundSignals;
        bestScopeUrl = typeof scope.url === "function" ? scope.url() : page.url();
      }

      if (foundSignals.length >= 2) {
        return {
          scopeUrl: typeof scope.url === "function" ? scope.url() : page.url(),
          foundSignals,
        };
      }
    }

    await page.waitForTimeout(500);
  }

  const error = new Error(
    `CUSTOM_VALUES_PAGE_NOT_READY foundSignals=${JSON.stringify(bestSignals)}`
  );
  error.scopeUrl = bestScopeUrl || page.url();
  error.foundSignals = bestSignals;
  throw error;
}

async function createLocalSession(storageStatePath) {
  if (!browserlessStorageStateExists(storageStatePath)) {
    throw new Error(
      `Missing local browser storage state at ${storageStatePath}. Run scripts/export-local-ghl-auth.js first.`
    );
  }

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: storageStatePath,
    viewport: null,
  });

  const page = context.pages()[0] || (await context.newPage());

  return {
    browser,
    context,
    page,
    local: true,
    stateExists: true,
    storageStatePath,
  };
}

async function openSessionWithLocalFallback() {
  if (CUSTOM_VALUES_BROWSER_MODE === "local") {
    return {
      ...(await createLocalSession(getStorageStatePath())),
      mode: "local",
    };
  }

  let browserlessSession = null;

  try {
    browserlessSession = await connectBrowserless({
      logger: (line) => console.log(`[CUSTOM VALUES] ${line}`),
      timeoutMs: 12000,
    });

    const context = browserlessSession.context;
    const page =
      browserlessSession.page ||
      context.pages()[0] ||
      (await context.newPage());

    if (!browserlessSession.stateExists) {
      throw new Error(
        "GHL authentication state is missing or expired. Re-run authentication setup."
      );
    }

    const authPage = await context.newPage();
    const verification = await verifyGhlAuthenticatedPage(
      authPage,
      LOCATION_ID,
      12000
    );
    await authPage.close().catch(() => {});

    if (!verification.ghlAuthenticated) {
      throw new Error(
        "GHL authentication state is missing or expired. Re-run authentication setup."
      );
    }

    return {
      ...browserlessSession,
      page,
      mode: "browserless",
    };
  } catch (error) {
    if (browserlessSession) {
      await closeBrowserlessSession(browserlessSession).catch(() => {});
    }

    console.log(
      "[CUSTOM VALUES] Browserless unavailable, falling back to local storage state"
    );
    return {
      ...(await createLocalSession(getStorageStatePath())),
      mode: "local",
    };
  }
}

async function ensureFolder(page, folderName) {
  if (!folderName) {
    return { status: "existing", step: "skip", error: null };
  }

  let folderStep = "tab";
  let folderError = null;

  try {
    logFolderStep("01 tab");
    await clickByText(page, [/^folders$/i, /folders/i]);
    await page.waitForTimeout(1500);

    folderStep = "existing_check";
    logFolderStep("02 existing check");
    const before = await currentBodyText(page);
    if (before.includes(normalize(folderName))) {
      return { status: "existing", step: "existing_check", error: null };
    }

    folderStep = "add_folder";
    logFolderStep("03 add-folder click");
    await clickByText(page, [/^add folder$/i, /add folder/i, /add new custom value folder/i, /new folder/i, /create folder/i]);

    folderStep = "modal_open";
    logFolderStep("04 modal open");
    const dialog = page.getByRole("dialog").first();
    await dialog.waitFor({ state: "visible", timeout: 10000 });

    const dialogScope = dialog;
    folderStep = "input_found";
    logFolderStep("05 input found");
    const filled = await fillFirst(
      dialogScope,
      [
        dialogScope.getByLabel(/folder/i),
        dialogScope.getByLabel(/name/i),
        dialogScope.locator('input[placeholder*="folder" i]').first(),
        dialogScope.locator('input[placeholder*="name" i]').first(),
        dialogScope.locator('input[name*="folder" i]').first(),
        dialogScope.locator('input[name*="name" i]').first(),
        dialogScope.locator('input[type="text"]').first(),
      ],
      folderName
    );

    if (!filled) {
      return { status: "failed", step: "input_found", error: "Folder name input was not found" };
    }
    folderStep = "name_filled";
    logFolderStep("06 name filled");

    folderStep = "submit_found";
    logFolderStep("07 submit found");
    const submitButton = await firstVisible([
      dialogScope.getByRole("button", { name: /^create folder$/i }).last(),
      dialogScope.getByRole("button", { name: /^create$/i }).last(),
      dialogScope.getByRole("button", { name: /^save$/i }).last(),
      dialogScope.getByRole("button", { name: /^add$/i }).last(),
      dialogScope.getByText(/^create folder$/i).last(),
      dialogScope.getByText(/^create$/i).last(),
      dialogScope.getByText(/^save$/i).last(),
      dialogScope.getByText(/^add$/i).last(),
    ]);

    if (!submitButton) {
      return { status: "failed", step: "submit_found", error: "Folder submit button was not found" };
    }

    folderStep = "submitted";
    await submitButton.click({ force: true });
    logFolderStep("08 submitted");

    await dialog.waitFor({ state: "hidden", timeout: 10000 });
    await page.waitForTimeout(1000);

    await clickByText(page, [/^all values$/i, /all values/i]).catch(() => {});
    await page.waitForTimeout(500);
    await clickByText(page, [/^folders$/i, /folders/i]);
    await waitForBodyText(page, folderName, 10000);

    folderStep = "verified";
    logFolderStep("09 verified");
    const after = await currentBodyText(page);
    if (after.includes(normalize(folderName))) {
      return { status: "created", step: "verified", error: null };
    }

    return { status: "failed", step: "verified", error: `Folder "${folderName}" was not visible after create` };
  } catch (error) {
    folderError = error?.message || "Folder creation flow failed";
    return { status: "failed", step: folderStep, error: folderError };
  }
}

async function chooseFolder(page, folderName) {
  if (!folderName) {
    return false;
  }

  const select = page.locator("#move-to-folder-select .hr-base-selection-label").first();
  if (!(await isVisible(select))) {
    return false;
  }

  await select.click({ force: true });
  const escaped = escapeRegExp(folderName);
  const options = page.getByText(new RegExp(`^\\s*${escaped}\\s*$`, "i"));
  const visibleOptions = [];
  for (let index = 0; index < await options.count(); index += 1) {
    const option = options.nth(index);
    if (await isVisible(option)) {
      visibleOptions.push(option);
    }
  }

  if (visibleOptions.length !== 1) {
    throw new Error(`Expected exactly one visible folder option named "${folderName}", found ${visibleOptions.length}.`);
  }

  await visibleOptions[0].click({ force: true });
  return true;
}

async function locateCustomValueRow(page, itemName, itemId = "") {
  if (itemId) {
    const idRow = page.locator(`tr[data-id="${String(itemId).replace(/["\\]/g, "\\$&")}"]`).first();
    if (await isVisible(idRow)) {
      return idRow;
    }
  }

  const escaped = escapeRegExp(itemName);
  const exactText = page.getByText(new RegExp(`^\\s*${escaped}\\s*$`, "i"));
  const rows = [];
  for (let index = 0; index < await exactText.count(); index += 1) {
    const row = exactText.nth(index).locator("xpath=ancestor::tr[1]");
    if (await isVisible(row)) {
      rows.push(row);
    }
  }

  if (rows.length === 1) {
    return rows[0];
  }

  return null;
}

async function refreshCustomValuesPage(page) {
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await verifyCustomValuesPage(page);
}

async function openCustomValueActions(page, itemName, itemId = "") {
  const row = await locateCustomValueRow(page, itemName, itemId);
  if (!row) {
    throw new Error(`Unable to find custom value row for "${itemName}".`);
  }

  const candidates = [
    row.locator("td").last().locator("svg").last(),
  ];

  const button = await firstVisible(candidates);
  if (!button) {
    throw new Error(`Unable to find actions control for "${itemName}".`);
  }

  await button.click({ force: true });
  return row;
}

async function openFolderAndVerifyCustomValue(page, folderName, itemName, itemId = "") {
  await clickByText(page, [/^folders$/i]).catch(() => {});
  await page.waitForTimeout(500);

  const folderPattern = new RegExp(`^\\s*${escapeRegExp(folderName)}\\s*$`, "i");
  const folderNames = page.getByText(folderPattern);
  const visibleFolderNames = [];
  for (let index = 0; index < await folderNames.count(); index += 1) {
    const folderNameLocator = folderNames.nth(index);
    if (await isVisible(folderNameLocator)) {
      visibleFolderNames.push(folderNameLocator);
    }
  }

  if (visibleFolderNames.length !== 1) {
    throw new Error(`Expected exactly one visible folder named "${folderName}", found ${visibleFolderNames.length}.`);
  }

  const folderUrlBefore = page.url();
  await visibleFolderNames[0].click({ force: true });
  await page.waitForURL(
    (url) => url.toString() !== folderUrlBefore && url.searchParams.has("parentId"),
    { timeout: 10000 }
  );
  await page.waitForTimeout(700);
  const body = await currentBodyText(page);
  const folderViewMarker = normalize(`Showing all custom values inside the ${folderName} folder.`);
  if (!page.url().includes("parentId=") || !body.includes(folderViewMarker)) {
    throw new Error(`Folder "${folderName}" did not open its dedicated contents view.`);
  }
  const row = await locateCustomValueRow(page, itemName, itemId);
  if (!row) {
    throw new Error(`Custom value "${itemName}" was not found inside folder "${folderName}".`);
  }
  return true;
}

async function moveCustomValueToFolder(page, itemName, folderName, itemId = "") {
  if (!folderName) {
    return { moved: false, skipped: true };
  }

  const debug = {
    exactValueFound: false,
    actionMenuOpened: false,
    moveToFolderClicked: false,
    folderPickerOpened: false,
    exactFolderFound: false,
    folderSelected: false,
    confirmationClicked: false,
    refreshCompleted: false,
    valueFoundInsideFolder: false,
  };

  try {
    await refreshCustomValuesPage(page);
    debug.refreshCompleted = true;
    await clickByText(page, [/^all values$/i]).catch(() => {});
    await page.waitForTimeout(500);

    const row = await locateCustomValueRow(page, itemName, itemId);
    debug.exactValueFound = Boolean(row);
    if (!row) {
      throw new Error(`Unable to find exact Custom Value row for "${itemName}".`);
    }

    await openCustomValueActions(page, itemName, itemId);
    debug.actionMenuOpened = true;

    const moveButton = page.getByText(/^Move to folder$/i).last();
    if (!(await isVisible(moveButton))) {
      throw new Error(`Unable to find exact Move To Folder control for "${itemName}".`);
    }
    await moveButton.click({ force: true });
    debug.moveToFolderClicked = true;

    const dialog = page.locator("#move-to-folder-modal").first();
    await dialog.waitFor({ state: "visible", timeout: 10000 });
    debug.folderPickerOpened = true;
    debug.exactFolderFound = await page.getByText(new RegExp(`^\\s*${escapeRegExp(folderName)}\\s*$`, "i")).count() > 0;

    const chosen = await chooseFolder(dialog, folderName);
    if (!chosen) {
      throw new Error(`Unable to choose exact folder "${folderName}" for "${itemName}".`);
    }
    debug.folderSelected = true;

    const submitButton = dialog.getByRole("button", { name: /^Move$/i }).first();
    if (!(await isVisible(submitButton))) {
      throw new Error(`Unable to find exact Move confirmation for "${itemName}".`);
    }
    await submitButton.click({ force: true });
    debug.confirmationClicked = true;
    await dialog.waitFor({ state: "hidden", timeout: 10000 });

    await refreshCustomValuesPage(page);
    debug.refreshCompleted = true;
    debug.valueFoundInsideFolder = await openFolderAndVerifyCustomValue(page, folderName, itemName, itemId);
    logFolderStep("10 association verified", JSON.stringify(debug));
    console.log(`CUSTOM_VALUE_FOLDER_DEBUG:${JSON.stringify(debug)}`);
    return { moved: true, skipped: false, rowFound: true, folderVerified: true, debug };
  } catch (error) {
    console.log(`CUSTOM_VALUE_FOLDER_DEBUG:${JSON.stringify(debug)}`);
    throw error;
  }
}

async function ensureValue(page, item, folderName) {
  const body = await currentBodyText(page);
  if (body.includes(normalize(item.name))) {
    if (folderName) {
      await moveCustomValueToFolder(page, item.name, folderName);
      return { created: false, skipped: false, moved: true };
    }
    return { created: false, skipped: true };
  }

  await clickByText(page, [/new custom value/i, /\+ add custom value/i, /add custom value/i]);

  const filledName = await fillFirst(
    page,
    [
      page.getByLabel(/name/i),
      page.locator('input[placeholder*="name" i]').first(),
      page.locator('input[type="text"]').first(),
    ],
    item.name
  );

  if (!filledName) {
    throw new Error(`Custom value name input was not found for "${item.name}".`);
  }

  const filledValue = await fillFirst(
    page,
    [
      page.getByLabel(/value/i),
      page.locator('textarea[placeholder*="value" i]').first(),
      page.locator('input[placeholder*="value" i]').first(),
      page.locator('textarea').first(),
    ],
    item.value
  );

  if (!filledValue) {
    throw new Error(`Custom value value input was not found for "${item.name}".`);
  }

  if (folderName) {
    await chooseFolder(page, folderName);
  }

  await clickByText(page, [/save/i, /create/i]);
  await waitForBodyText(page, item.name);
  return { created: true, skipped: false };
}

async function main() {
  const items = parseItems();
  const summary = {
    folderName: FOLDER_NAME,
    folderStatus: "existing",
    folderStep: "",
    folderError: "",
    values: [],
    created: 0,
    skipped: 0,
    failed: 0,
    pageReady: false,
    scopeUrl: "",
    foundSignals: [],
    folderAssociation: "not_yet_implemented",
  };

  if (!LOCATION_ID) {
    throw new Error("Missing GHL_LOCATION_ID");
  }

  if (!GHL_TOKEN) {
    throw new Error("Missing GHL_TOKEN");
  }

  if (!FOLDER_NAME && !items.length) {
    throw new Error("Missing CUSTOM_VALUE_FOLDER_NAME and CUSTOM_VALUES");
  }

  console.log("Browser automation: Browserless remote with local fallback");

  let session = null;

  try {
    session = await openSessionWithLocalFallback();
    const context = session.context;
    const page = session.page || context.pages()[0] || (await context.newPage());

    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(90000);

    await openCustomValuesPage(page, LOCATION_ID);
    const ready = await verifyCustomValuesPage(page);
    summary.pageReady = true;
    summary.scopeUrl = ready.scopeUrl;
    summary.foundSignals = ready.foundSignals;
    console.log("CUSTOM_VALUES_PAGE_READY");

    const folderResult = await ensureFolder(page, FOLDER_NAME);
    summary.folderStatus = folderResult.status;
    summary.folderStep = folderResult.step;
    summary.folderError = folderResult.error || "";
    if (summary.folderStatus === "created") {
      summary.created += 1;
    } else if (summary.folderStatus === "existing") {
      summary.skipped += 1;
    } else {
      summary.failed += 1;
    }

    const values = [];
    for (const item of items) {
      try {
        let status = await ensureCustomValueApi(GHL_TOKEN, LOCATION_ID, item);

        if (status === "failed") {
          throw new Error(`API ensure failed for "${item.name}".`);
        }

        if (FOLDER_NAME) {
          await moveCustomValueToFolder(page, item.name, FOLDER_NAME);
        }

        values.push({ name: item.name, status });
        if (status === "created") {
          summary.created += 1;
        } else {
          summary.skipped += 1;
        }
      } catch (error) {
        try {
          await clickByText(page, [/^all values$/i, /all values/i]).catch(() => {});
          await page.waitForTimeout(1000);
          const uiResult = await ensureValue(page, item, FOLDER_NAME);
          const status = uiResult.created ? "created" : "existing";
          values.push({ name: item.name, status });
          if (uiResult.created) {
            summary.created += 1;
          } else {
            summary.skipped += 1;
          }
        } catch (uiError) {
          values.push({ name: item.name, status: "failed" });
          summary.failed += 1;
          console.error(formatBrowserlessError(uiError || error));
        }
      }
    }

    summary.values = values;
    summary.success = summary.failed === 0;
    console.log(`CUSTOM_VALUES_RESULT_JSON:${JSON.stringify(summary)}`);
    return summary;

  } catch (error) {
    summary.failed += 1;
    summary.success = false;
    summary.error = formatBrowserlessError(error);
    console.error(summary.error);
    console.log(`CUSTOM_VALUES_RESULT_JSON:${JSON.stringify(summary)}`);
    process.exitCode = 1;
    return summary;
  } finally {
    if (session) {
      await saveBrowserlessStorageState(session.context, getStorageStatePath()).catch(
        () => {}
      );
      await closeBrowserlessSession(session).catch(() => {});
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(formatBrowserlessError(error));
    process.exitCode = 1;
  });
}

module.exports = {
  createLocalSession,
  ensureFolder,
  ensureValue,
  moveCustomValueToFolder,
  openCustomValuesPage,
  openSessionWithLocalFallback,
  verifyCustomValuesPage,
};
