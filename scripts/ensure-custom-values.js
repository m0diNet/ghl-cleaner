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
const STORAGE_STATE_PATH = path.join(
  __dirname,
  "..",
  "browser-state",
  "ghl-storage-state.json"
);
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
      ...(await createLocalSession(STORAGE_STATE_PATH)),
      mode: "local",
    };
  }

  let browserlessSession = null;

  try {
    browserlessSession = await connectBrowserless({
      logger: (line) => console.log(`[CUSTOM VALUES] ${line}`),
      timeoutMs: 45000,
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
      45000
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
      ...(await createLocalSession(STORAGE_STATE_PATH)),
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

  const candidates = [
    page.getByLabel(/folder/i),
    page.getByRole("combobox", { name: /folder/i }),
    page.locator('input[placeholder*="folder" i]').first(),
    page.locator('input[name*="folder" i]').first(),
  ];

  for (const candidate of candidates) {
    if (!(await isVisible(candidate))) {
      continue;
    }

    await candidate.click({ force: true }).catch(() => {});
    await candidate.fill(folderName).catch(async () => {
      await candidate.press("Control+A").catch(() => {});
      await candidate.type(folderName, { delay: 10 }).catch(() => {});
    });
    await candidate.press("Enter").catch(() => {});
    return true;
  }

  return false;
}

async function ensureValue(page, item, folderName) {
  const body = await currentBodyText(page);
  if (body.includes(normalize(item.name))) {
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
      await saveBrowserlessStorageState(session.context, STORAGE_STATE_PATH).catch(
        () => {}
      );
      await closeBrowserlessSession(session).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(formatBrowserlessError(error));
  process.exitCode = 1;
});
