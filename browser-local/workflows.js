require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  cleanText,
  isHeaderText,
  isPlaceholderText,
  looksLikeHeaderOnlyRow,
  normalizeSignatureText,
  normalizeText,
  rowLooksLikeFolder,
  canonicalizeRowNameFromText,
  getInventoryRowSelectors,
} = require("../services/browser-inventory-shared");
const {
  normalizeDeleteJob,
  normalizeDeleteJobs,
  toText,
} = require("../web/services/deleteJob");

const AUTH_ORIGIN = "https://app.olspsystem.com";
function getStorageStatePath() {
  return String(
    process.env.BROWSER_STORAGE_STATE_PATH ||
      path.join(__dirname, "..", "browser-state", "ghl-storage-state.json")
  ).trim();
}
const ROOT_FOLDER_LABEL = "Home";

const WORKFLOW_FRAME_FRAGMENT = "client-app-automation-workflows.leadconnectorhq.com";
const FRAME_WAIT_MS = 120000;
const MENU_WAIT_MS = 8000;
const ROOT_SCOPE_WAIT_MS = 30000;
const FOLDER_OPEN_WAIT_MS = 30000;
const RETURN_ROOT_WAIT_MS = 120000;
const DELETE_VERIFY_WAIT_MS = 3000;
const AUTHENTICATED_LOCATION_ID = toText(process.env.GHL_LOCATION_ID || "");

const CRITICAL_PATTERNS = [
  /\butilities?\b/i,
  /\bwebhooks?\b/i,
  /\blive\b/i,
  /\bproduction\b/i,
  /\bpayments?\b/i,
  /\bbilling\b/i,
  /\bcustomers?\b/i,
  /\bcontact creation\b/i,
  /\bsystem\b/i,
  /\badmin\b/i,
];

function normalize(value) {
  return normalizeText(value);
}

function isProtectedRowName(value) {
  return /DO NOT REMOVE/i.test(String(value || ""));
}

function isCriticalRowName(value) {
  const text = String(value || "");
  return CRITICAL_PATTERNS.some((pattern) => pattern.test(text));
}

function isSafeCandidateName(value) {
  const text = cleanText(value);
  return Boolean(text) && !isProtectedRowName(text) && !isCriticalRowName(text);
}

async function isVisible(locator) {
  return locator.isVisible().catch(() => false);
}

async function isEnabled(locator) {
  return locator.isEnabled().catch(() => false);
}

async function collectVisibleTextsFromScope(scope) {
  const selectors = [
    '[role="menu"]',
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[data-radix-popper-content-wrapper]',
    '[data-popper-placement]',
    '[data-state="open"]',
    '[class*="popover" i]',
    '[class*="dropdown" i]',
    '[class*="menu" i]',
  ];
  const seen = new Set();
  const texts = [];

  for (const selector of selectors) {
    const containerCount = await scope.locator(selector).count().catch(() => 0);

    for (let index = 0; index < containerCount; index += 1) {
      const container = scope.locator(selector).nth(index);
      if (!(await isVisible(container))) {
        continue;
      }

      const containerText = cleanText(await container.innerText().catch(() => ""));
      if (!containerText) {
        continue;
      }

      const pieces = containerText
        .split(/\n+/g)
        .map((piece) => cleanText(piece))
        .filter(Boolean);

      for (const piece of pieces) {
        const key = normalizeSignatureText(piece);
        if (!key || seen.has(key)) {
          continue;
        }
        seen.add(key);
        texts.push(piece);
      }
    }
  }

  return texts;
}

async function getVisibleWorkflowFrame(page, timeoutMs = FRAME_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) =>
      String(candidate.url() || "").includes(WORKFLOW_FRAME_FRAGMENT)
    );

    if (frame) {
      return frame;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    `Workflow frame with visible actions was not found within ${timeoutMs}ms.`
  );
}

async function waitForActionButtons(frame, timeoutMs = ROOT_SCOPE_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const buttons = frame.locator('[aria-label="Workflow list actions"]');
    const count = await buttons.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      if (await isVisible(buttons.nth(index))) {
        return true;
      }
    }

    await frame.page().waitForTimeout(500);
  }

  return false;
}

async function collectVisibleRows(frame) {
  const rowsLocator = frame.locator(getInventoryRowSelectors().join(", "));
  const count = await rowsLocator.count().catch(() => 0);
  const seen = new Set();
  const rows = [];

  for (let index = 0; index < count; index += 1) {
    const row = rowsLocator.nth(index);
    if (!(await isVisible(row))) {
      continue;
    }

    const rowText = cleanText(await row.innerText().catch(() => ""));
    if (!rowText || isHeaderText(rowText) || looksLikeHeaderOnlyRow("workflows", rowText)) {
      continue;
    }
    if (isPlaceholderText("workflows", rowText)) {
      continue;
    }

    const box = await row.boundingBox().catch(() => null);
    const signature = [
      normalizeSignatureText(rowText),
      box ? `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}` : `row-${index}`,
    ].join("|");

    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);

    rows.push({
      locator: row,
      rowText,
      name: normalizeSignatureText(rowText) || rowText,
      signature,
      box,
    });
  }

  return rows;
}

function pickPreferredFolder(rows) {
  const safeFolders = rows.filter(
    (row) =>
      row.type === "folder" &&
      !row.protected &&
      isSafeCandidateName(row.name)
  );

  if (!safeFolders.length) {
    return null;
  }

  return safeFolders[0];
}

function findMatchingFolderRow(rows, folderName) {
  const target = normalizeSignatureText(folderName);

  return (
    rows.find((row) => normalizeSignatureText(row.name) === target) ||
    rows.find((row) => normalizeSignatureText(row.rowText) === target) ||
    rows.find((row) => normalize(row.name) === normalize(folderName)) ||
    rows.find((row) => normalize(row.rowText) === normalize(folderName)) ||
    null
  );
}

function looksDangerousWorkflowName(value) {
  return [
    /DO NOT REMOVE/i,
    /\bUtilities\b/i,
    /\bWebhooks\b/i,
    /\bProduction\b/i,
    /\bPayment\b/i,
    /\bBilling\b/i,
    /\bSystem\b/i,
    /\bAdmin\b/i,
  ].some((pattern) => pattern.test(String(value || "")));
}

function getWorkflowsUrl(locationId) {
  const trimmed = toText(locationId);
  return `${AUTH_ORIGIN}/v2/location/${trimmed}/automation/workflows?listTab=all`;
}

function parseDeleteJobsFromEnv() {
  const source = String(process.env.DELETE_JOBS_JSON || "").trim();
  if (!source) {
    return { jobs: [], error: "DELETE_JOBS_JSON is required." };
  }

  try {
    const parsed = JSON.parse(source);
    if (!Array.isArray(parsed)) {
      return { jobs: [], error: "DELETE_JOBS_JSON must be a JSON array." };
    }
    const normalized = parsed.map((item) => normalizeDeleteJob(item, "workflow"));
    return { jobs: normalized };
  } catch (error) {
    return { jobs: [], error: `DELETE_JOBS_JSON is invalid: ${error.message}` };
  }
}

function selectSingleWorkflowJob(jobs) {
  const parsedJobs = Array.isArray(jobs) ? jobs.filter(Boolean) : [];

  if (parsedJobs.length !== 1) {
    return {
      job: null,
      jobReceived: parsedJobs.length > 0,
      error:
        parsedJobs.length === 0
          ? "No workflow job was provided."
          : "DELETE_JOBS_JSON must contain exactly one workflow job.",
    };
  }

  const job = parsedJobs[0];
  const resourceType = toText(job.resourceType);
  if (resourceType && resourceType !== "workflow") {
    return {
      job: null,
      jobReceived: true,
      error: `Unsupported resourceType "${resourceType}".`,
    };
  }

  const locationId = toText(job.locationId);
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
      error: "Workflow job location does not match the authenticated selected location.",
    };
  }

  if (!toText(job.resourceId)) {
    return {
      job: null,
      jobReceived: true,
      error: "Missing resourceId.",
    };
  }

  if (!toText(job.resourceName)) {
    return {
      job: null,
      jobReceived: true,
      error: "Missing resourceName.",
    };
  }

  return {
    job,
    jobReceived: true,
    error: "",
  };
}

function hasProtectedWorkflowName(value) {
  const text = toText(value);
  return (
    /DO NOT REMOVE/i.test(text) ||
    /\bUtilities\b/i.test(text) ||
    /\bWebhooks\b/i.test(text)
  );
}

function isRootFolderTarget(job) {
  const parentName = toText(job?.parentName);
  return !parentName || normalizeSignatureText(parentName) === normalizeSignatureText(ROOT_FOLDER_LABEL);
}

async function getRowResourceId(rowLocator) {
  const link = rowLocator.locator('a[role="link"], a[href], [role="link"]').first();
  const id = cleanText(await link.getAttribute("id").catch(() => ""));
  return id || "";
}

async function resolveWorkflowRowIdentity(rowDescriptor) {
  return {
    resolvedRowName: rowDescriptor.name || rowDescriptor.rowText || "",
    resolvedResourceId: await getRowResourceId(rowDescriptor.locator),
  };
}

async function findRowActionButtons(row) {
  const buttons = row.locator('[aria-label="Workflow list actions"]');
  const count = await buttons.count().catch(() => 0);
  const candidates = [];

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const visible = await isVisible(button);
    const enabled = visible && (await isEnabled(button));
    const box = await button.boundingBox().catch(() => null);
    candidates.push({
      index,
      visible,
      enabled,
      box,
      locator: button,
    });
  }

  return candidates;
}

async function clickRowTitle(row, targetText) {
  if (!row) {
    throw new Error(`Cannot click row title for "${targetText}" because the row locator is missing.`);
  }

  const attempts = [
    row.locator('a[href], [role="link"], [role="button"], button').filter({ hasText: targetText }).first(),
    row.locator('a[href], [role="link"], [role="button"], button').first(),
  ];

  for (const candidate of attempts) {
    if (await isVisible(candidate)) {
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      await candidate.click({ timeout: 5000, force: true }).catch(() => {});
      return true;
    }
  }

  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.click({ timeout: 5000, force: true }).catch(() => {});
  return true;
}

async function clickRowActionButton(row) {
  const candidates = await findRowActionButtons(row);
  const selected = candidates.find((candidate) => candidate.visible && candidate.enabled);

  if (!selected) {
    throw new Error("Row-local Actions button was not found.");
  }

  await selected.locator.scrollIntoViewIfNeeded().catch(() => {});
  await selected.locator.click({ timeout: 5000 }).catch((error) => {
    throw new Error(`Failed to open Workflow list actions: ${error.message}`);
  });

  return selected;
}

async function collectMenuTexts(page, frame) {
  const texts = [
    ...(await collectVisibleTextsFromScope(frame).catch(() => [])),
    ...(await collectVisibleTextsFromScope(page).catch(() => [])),
  ];
  const seen = new Set();
  return texts.filter((text) => {
    const key = normalizeSignatureText(text);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function waitForMenuLabels(page, frame, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  const knownLabels = [
    "Edit workflow",
    "Rename workflow",
    "Open in new tab",
    "Draft workflow",
    "Move to folder",
    "Duplicate workflow",
    "Copy to sub-account",
    "Delete workflow",
    "Delete folder",
    "Edit folder",
    "Rename folder",
    "Manage permissions",
  ];

  while (Date.now() < deadline) {
    const scopeTexts = await collectMenuTexts(page, frame);
    const menuLabels = [];

    for (const label of knownLabels) {
      const needle = normalize(label);
      const visible = scopeTexts.some((text) => normalize(text).includes(needle));
      if (visible) {
        menuLabels.push(label);
      }
    }

    if (menuLabels.length) {
      return { scopeTexts, menuLabels };
    }

    await page.waitForTimeout(250);
  }

  const scopeTexts = await collectMenuTexts(page, frame);
  const menuLabels = [];
  for (const label of knownLabels) {
    const needle = normalize(label);
    const visible = scopeTexts.some((text) => normalize(text).includes(needle));
    if (visible) {
      menuLabels.push(label);
    }
  }

  return { scopeTexts, menuLabels };
}

async function findDialog(page) {
  const dialogs = page.locator('[role="dialog"], [aria-modal="true"]');
  const count = await dialogs.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const dialog = dialogs.nth(index);
    if (await isVisible(dialog)) {
      return dialog;
    }
  }

  return null;
}

async function findVisibleMenuItem(page, frame, text, timeoutMs = MENU_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const candidates = [
      page.getByText(text, { exact: true }).first(),
      frame.getByText(text, { exact: true }).first(),
      page.locator(`text=${text}`).first(),
      frame.locator(`text=${text}`).first(),
    ];

    for (const candidate of candidates) {
      if (await isVisible(candidate)) {
        return candidate;
      }
    }

    await page.waitForTimeout(250);
  }

  return null;
}

async function findConfirmationInput(page) {
  const dialog = await findDialog(page);
  if (!dialog) {
    return null;
  }

  const candidates = [
    dialog.locator('input, textarea').first(),
    dialog.getByPlaceholder(/delete/i).first(),
    dialog.getByLabel(/delete/i).first(),
  ];

  for (const candidate of candidates) {
    if (await isVisible(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function clickFinalDeleteButton(page) {
  const dialog = await findDialog(page);
  const scope = dialog || page;
  const candidates = [
    scope.getByRole("button", { name: /^Delete$/i }).first(),
    scope.getByText(/^Delete$/i).first(),
  ];

  for (const candidate of candidates) {
    if (await isVisible(candidate)) {
      await candidate.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }

  return false;
}

async function collectDialogsFromScope(scope, source) {
  const selectors = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    ".modal",
    ".n-modal",
    ".hr-modal",
  ];
  const dialogs = [];

  for (const selector of selectors) {
    const count = await scope.locator(selector).count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const dialog = scope.locator(selector).nth(index);
      if (!(await isVisible(dialog))) {
        continue;
      }

      const dialogText = cleanText(await dialog.innerText().catch(() => ""));
      const inputCandidates = dialog.locator("input, textarea, [contenteditable='true']");
      const inputCount = await inputCandidates.count().catch(() => 0);
      const buttonCandidates = dialog.locator("button, [role='button']");
      const buttonCount = await buttonCandidates.count().catch(() => 0);

      const inputs = [];
      const placeholders = [];
      const buttons = [];

      for (let inputIndex = 0; inputIndex < inputCount; inputIndex += 1) {
        const input = inputCandidates.nth(inputIndex);
        if (!(await isVisible(input))) {
          continue;
        }

        const placeholder = cleanText(await input.getAttribute("placeholder").catch(() => ""));
        const ariaLabel = cleanText(await input.getAttribute("aria-label").catch(() => ""));
        const role = cleanText(await input.getAttribute("role").catch(() => ""));
        const type = cleanText(await input.getAttribute("type").catch(() => ""));
        const label = placeholder || ariaLabel || role || type || `input-${inputIndex}`;
        inputs.push(label);
        if (placeholder) {
          placeholders.push(placeholder);
        }
      }

      for (let buttonIndex = 0; buttonIndex < buttonCount; buttonIndex += 1) {
        const button = buttonCandidates.nth(buttonIndex);
        if (!(await isVisible(button))) {
          continue;
        }

        const label = cleanText(
          (await button.innerText().catch(() => "")) ||
            (await button.getAttribute("aria-label").catch(() => "")) ||
            (await button.getAttribute("title").catch(() => ""))
        );
        if (label) {
          buttons.push(label);
        }
      }

      dialogs.push({
        source,
        text: dialogText,
        inputs: Array.from(new Set(inputs)),
        buttons: Array.from(new Set(buttons)),
        placeholders: Array.from(new Set(placeholders)),
      });
    }
  }

  return dialogs;
}

async function findVisibleDialogInScope(scope) {
  const selectors = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    ".modal",
    ".n-modal",
    ".hr-modal",
  ];

  for (const selector of selectors) {
    const count = await scope.locator(selector).count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const dialog = scope.locator(selector).nth(index);
      if (await isVisible(dialog)) {
        return dialog;
      }
    }
  }

  return null;
}

async function waitForConfirmationDialogs(page, frame, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const dialogs = [
      ...(await collectDialogsFromScope(frame, "frame").catch(() => [])),
      ...(await collectDialogsFromScope(page, "page").catch(() => [])),
    ];

    if (dialogs.length) {
      return dialogs;
    }

    await page.waitForTimeout(250);
  }

  return [];
}

async function refreshAndReopenFolder(page, folderRow) {
  await page.waitForTimeout(DELETE_VERIFY_WAIT_MS);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  const freshFrame = await getVisibleWorkflowFrame(page, RETURN_ROOT_WAIT_MS);
  const freshRootRows = await waitForCurrentScope(freshFrame, ROOT_SCOPE_WAIT_MS);
  const freshFolderRow = findMatchingFolderRow(freshRootRows, folderRow.name || folderRow.rowText);

  if (!freshFolderRow) {
    return { freshFrame, freshRootRows, folderOpened: false };
  }

  await clickRowTitle(freshFolderRow.locator, freshFolderRow.name || freshFolderRow.rowText);
  await page.waitForTimeout(1500);

  const reopenedFrame = await getVisibleWorkflowFrame(page, RETURN_ROOT_WAIT_MS);
  const reopenedRows = await waitForCurrentScope(reopenedFrame, FOLDER_OPEN_WAIT_MS);

  return {
    freshFrame: reopenedFrame,
    freshRootRows,
    folderOpened: reopenedRows.length > 0,
    reopenedRows,
  };
}

async function inspectRowMenu(page, frame, rowDescriptor) {
  const candidates = await findRowActionButtons(rowDescriptor.locator);
  const selected = candidates.find((candidate) => candidate.visible && candidate.enabled);

  if (!selected) {
    return {
      actionButtonCount: candidates.length,
      selectedActionIndex: null,
      menuText: "",
      menuLabels: [],
      deleteFolderVisible: false,
      deleteWorkflowVisible: false,
      type: "unknown",
    };
  }

  await selected.locator.scrollIntoViewIfNeeded().catch(() => {});
  await selected.locator.click({ timeout: 5000 }).catch((error) => {
    throw new Error(`Failed to open Workflow list actions: ${error.message}`);
  });
  await page.waitForTimeout(3000);

  const { scopeTexts, menuLabels } = await waitForMenuLabels(page, frame, 3000);
  const menuText = scopeTexts.join(" | ");

  const deleteFolderVisible = menuLabels.some((label) => /delete folder/i.test(label));
  const deleteWorkflowVisible = menuLabels.some((label) => /delete workflow/i.test(label));

  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);

  let type = "unknown";
  if (deleteFolderVisible) {
    type = "folder";
  } else if (deleteWorkflowVisible) {
    type = "workflow";
  } else if (rowLooksLikeFolder("workflows", rowDescriptor.rowText)) {
    type = "folder_candidate";
  }

  return {
    actionButtonCount: candidates.length,
    selectedActionIndex: selected.index,
    menuText,
    menuLabels,
    deleteFolderVisible,
    deleteWorkflowVisible,
    type,
  };
}

async function waitForCurrentScope(frame, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = await collectVisibleRows(frame);
    if (rows.length) {
      return rows;
    }

    await frame.page().waitForTimeout(500);
  }

  return [];
}

async function openFolderScope(page, folderRow) {
  await clickRowTitle(folderRow.locator, folderRow.name || folderRow.rowText);
  await page.waitForTimeout(1500);
  return waitForCurrentScope(page.frames().find((candidate) =>
    String(candidate.url() || "").includes(WORKFLOW_FRAME_FRAGMENT)
  ) || page.mainFrame(), FOLDER_OPEN_WAIT_MS);
}

async function returnToRootAndGetFrame(page, locationId) {
  await page.goto(getWorkflowsUrl(locationId), { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  return getVisibleWorkflowFrame(page, RETURN_ROOT_WAIT_MS);
}

async function main() {
  const startedAt = Date.now();
  const dryRun = String(process.env.WORKFLOW_DRY_RUN || "").trim().toLowerCase() === "true";
  const markerName = dryRun ? "WORKFLOW_TARGET_RESOLUTION_JSON" : "WORKFLOW_DELETE_RESULT_JSON";
  const result = {
    jobReceived: false,
    locationId: "",
    resourceId: "",
    resourceName: "",
    parentId: "",
    parentName: "",
    parentResolved: false,
    parentResolvedBy: "",
    targetFound: false,
    targetResolvedBy: "",
    resolvedRowName: "",
    resolvedResourceId: "",
    actionsFound: false,
    deleteWouldBeAvailable: false,
    deleteVisible: false,
    deleteClicked: false,
    confirmationCompleted: false,
    rowDisappeared: false,
    rowAbsentAfterRefresh: false,
    uiVerificationPassed: false,
    protectedTarget: false,
    dryRun,
    status: "failed",
    runtimeMs: 0,
    error: "",
  };

  const { jobs, error: jobsError } = parseDeleteJobsFromEnv();
  if (jobsError) {
    result.error = jobsError;
    result.runtimeMs = Date.now() - startedAt;
    console.log(`${markerName}:${JSON.stringify(result)}`);
    process.exitCode = 1;
    return;
  }

  const selection = selectSingleWorkflowJob(jobs);
  if (!selection.job) {
    result.error = selection.error;
    result.runtimeMs = Date.now() - startedAt;
    console.log(`${markerName}:${JSON.stringify(result)}`);
    process.exitCode = 1;
    return;
  }

  const job = selection.job;
  result.jobReceived = selection.jobReceived;
  result.locationId = toText(job.locationId);
  result.resourceId = toText(job.resourceId);
  result.resourceName = toText(job.resourceName);
  result.parentId = toText(job.parentId);
  result.parentName = toText(job.parentName);

  if (hasProtectedWorkflowName(result.parentName) || hasProtectedWorkflowName(result.resourceName)) {
    result.protectedTarget = true;
    result.error = "Protected workflow target rejected.";
    result.runtimeMs = Date.now() - startedAt;
    console.log(`${markerName}:${JSON.stringify(result)}`);
    process.exitCode = 1;
    return;
  }

  const storageStatePath = getStorageStatePath();
  if (!fs.existsSync(storageStatePath)) {
    throw new Error(`Storage state not found at ${storageStatePath}`);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: storageStatePath,
    viewport: null,
  });

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);

    await page.goto(getWorkflowsUrl(result.locationId), {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const frame = await getVisibleWorkflowFrame(page, FRAME_WAIT_MS);
    result.workflowFrameUrl = frame.url();

    const rootRows = await waitForCurrentScope(frame, ROOT_SCOPE_WAIT_MS);
    let scopeFrame = frame;
    let scopeRows = rootRows;
    let folderRow = null;

    if (!isRootFolderTarget(job)) {
      folderRow =
        findMatchingFolderRow(rootRows, result.parentName) ||
        rootRows.find((row) => normalizeSignatureText(row.name || row.rowText) === normalizeSignatureText(result.parentId));

      if (!folderRow) {
        result.error = `Parent folder not found for "${result.parentName}".`;
        result.runtimeMs = Date.now() - startedAt;
        console.log(`${markerName}:${JSON.stringify(result)}`);
        process.exitCode = 1;
        return;
      }

      await clickRowTitle(folderRow.locator, folderRow.name || folderRow.rowText);
      await page.waitForTimeout(1500);
      scopeFrame = await getVisibleWorkflowFrame(page, RETURN_ROOT_WAIT_MS);
      scopeRows = await waitForCurrentScope(scopeFrame, FOLDER_OPEN_WAIT_MS);
      result.parentResolvedBy = folderRow.name ? "parentName" : "parentId";
    } else {
      result.parentResolvedBy = "root";
    }

    result.parentResolved = true;

    let targetRow = null;
    let targetResolvedBy = "";
    for (const row of scopeRows) {
      const rowIdentity = await getRowResourceId(row.locator);
      if (rowIdentity && normalizeSignatureText(rowIdentity) === normalizeSignatureText(result.resourceId)) {
        targetRow = row;
        targetResolvedBy = "resourceId";
        break;
      }
    }

    if (!targetRow) {
      targetRow =
        scopeRows.find((row) => normalizeSignatureText(row.name || row.rowText) === normalizeSignatureText(result.resourceName)) ||
        scopeRows.find((row) => normalizeSignatureText(row.rowText) === normalizeSignatureText(result.resourceName)) ||
        null;
      if (targetRow) {
        targetResolvedBy = "resourceName";
      }
    }

    if (!targetRow) {
      result.error = `Workflow "${result.resourceName}" was not found.`;
      result.runtimeMs = Date.now() - startedAt;
      console.log(`${markerName}:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    result.targetFound = true;
    result.targetResolvedBy = targetResolvedBy;
    result.resolvedRowName = targetRow.name || targetRow.rowText || "";
    result.resolvedResourceId = await getRowResourceId(targetRow.locator);

    if (normalizeSignatureText(result.resolvedRowName) !== normalizeSignatureText(result.resourceName)) {
      result.error = `Workflow row name "${result.resolvedRowName}" did not exactly match "${result.resourceName}".`;
      result.runtimeMs = Date.now() - startedAt;
      console.log(`${markerName}:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    if (
      result.resolvedResourceId &&
      normalizeSignatureText(result.resolvedResourceId) !== normalizeSignatureText(result.resourceId)
    ) {
      result.error = `Workflow row id "${result.resolvedResourceId}" did not exactly match "${result.resourceId}".`;
      result.runtimeMs = Date.now() - startedAt;
      console.log(`${markerName}:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    if (hasProtectedWorkflowName(result.resolvedRowName) || hasProtectedWorkflowName(result.parentName)) {
      result.protectedTarget = true;
      result.error = "Protected workflow target rejected.";
      result.runtimeMs = Date.now() - startedAt;
      console.log(`${markerName}:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    const actionButton = await findRowActionButtons(targetRow.locator).then((items) =>
      items.find((item) => item.visible && item.enabled)
    );

    result.actionsFound = Boolean(actionButton);
    if (!actionButton) {
      result.error = "Exact row-local Actions button was not found.";
      result.runtimeMs = Date.now() - startedAt;
      console.log(`${markerName}:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    if (dryRun) {
      await actionButton.locator.scrollIntoViewIfNeeded().catch(() => {});
      await actionButton.locator.click({ timeout: 5000 }).catch((error) => {
        throw new Error(`Failed to open target workflow actions for dry-run: ${error.message}`);
      });
      const { menuLabels } = await waitForMenuLabels(page, scopeFrame, MENU_WAIT_MS);
      const deleteWorkflowItem = await findVisibleMenuItem(page, scopeFrame, "Delete workflow", MENU_WAIT_MS);
      result.deleteVisible = Boolean(deleteWorkflowItem) || menuLabels.some((label) => /delete workflow/i.test(label));
      result.deleteWouldBeAvailable = result.deleteVisible;
      result.actionsFound = true;
      await page.keyboard.press("Escape").catch(() => {});
      result.status = "resolved";
      result.runtimeMs = Date.now() - startedAt;
      console.log(`${markerName}:${JSON.stringify(result)}`);
      return;
    }

    await actionButton.locator.scrollIntoViewIfNeeded().catch(() => {});
    await actionButton.locator.click({ timeout: 5000 }).catch((error) => {
      throw new Error(`Failed to open target workflow actions: ${error.message}`);
    });
    result.deleteVisible = true;

    const deleteWorkflowItem = await findVisibleMenuItem(page, scopeFrame, "Delete workflow", MENU_WAIT_MS);
    if (!deleteWorkflowItem) {
      result.error = "Delete workflow was not visible.";
      result.runtimeMs = Date.now() - startedAt;
      console.log(`${markerName}:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    await deleteWorkflowItem.click({ timeout: 5000 }).catch((error) => {
      throw new Error(`Failed to click Delete workflow: ${error.message}`);
    });
    result.deleteClicked = true;

    const dialog = await findVisibleDialogInScope(scopeFrame) || await findVisibleDialogInScope(page);
    if (!dialog) {
      result.error = "No confirmation dialog was visible after Delete workflow click.";
      result.runtimeMs = Date.now() - startedAt;
      console.log(`${markerName}:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    const confirmationInput =
      (await dialog.locator('input[placeholder="Delete"], textarea[placeholder="Delete"]').first().isVisible().catch(() => false)
        ? dialog.locator('input[placeholder="Delete"], textarea[placeholder="Delete"]').first()
        : null) ||
      (await dialog.getByPlaceholder("Delete").first().isVisible().catch(() => false)
        ? dialog.getByPlaceholder("Delete").first()
        : null);

    if (!confirmationInput) {
      result.error = "Confirmation input was not found.";
      result.runtimeMs = Date.now() - startedAt;
      console.log(`${markerName}:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    await confirmationInput.fill("Delete", { timeout: 5000 }).catch(() => {});
    const finalDeleteButton =
      (await dialog.getByRole("button", { name: /^Delete$/i }).first().isVisible().catch(() => false)
        ? dialog.getByRole("button", { name: /^Delete$/i }).first()
        : null) ||
      (await dialog.getByText(/^Delete$/i).first().isVisible().catch(() => false)
        ? dialog.getByText(/^Delete$/i).first()
        : null);

    if (!finalDeleteButton) {
      result.error = "Final Delete button was not found.";
      result.runtimeMs = Date.now() - startedAt;
      console.log(`${markerName}:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    await finalDeleteButton.click({ timeout: 5000 }).catch((error) => {
      throw new Error(`Failed to click final Delete: ${error.message}`);
    });
    result.confirmationCompleted = true;

    await page.waitForTimeout(DELETE_VERIFY_WAIT_MS);

    const postRefresh = await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).then(async () => {
      const freshFrame = await getVisibleWorkflowFrame(page, RETURN_ROOT_WAIT_MS);
      const freshRows = await waitForCurrentScope(freshFrame, ROOT_SCOPE_WAIT_MS);
      return { freshFrame, freshRows };
    }).catch(() => null);

    if (!postRefresh) {
      result.error = "Unable to refresh after delete.";
      result.runtimeMs = Date.now() - startedAt;
      console.log(`${markerName}:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    const stillPresent = postRefresh.freshRows.some((row) =>
      normalizeSignatureText(row.name || row.rowText) === normalizeSignatureText(result.resolvedRowName)
    );

    result.rowDisappeared = !stillPresent;
    result.rowAbsentAfterRefresh = !stillPresent;
    result.uiVerificationPassed = !stillPresent;
    result.status = stillPresent ? "verification_failed" : "deleted";
    if (stillPresent) {
      result.error = `Target workflow still present after refresh: ${result.resolvedRowName}`;
    }

    result.runtimeMs = Date.now() - startedAt;
    console.log(`${markerName}:${JSON.stringify(result)}`);
  } catch (error) {
    result.runtimeMs = Date.now() - startedAt;
    result.error = String(error?.message || error);
    console.log(`${markerName}:${JSON.stringify(result)}`);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(String(error?.stack || error?.message || error));
    process.exitCode = 1;
  });
}

module.exports = {
  getWorkflowsUrl,
  hasProtectedWorkflowName,
  isRootFolderTarget,
  parseDeleteJobsFromEnv,
  resolveWorkflowRowIdentity,
  selectSingleWorkflowJob,
};
