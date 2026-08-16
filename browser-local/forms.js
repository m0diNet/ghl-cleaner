require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const LOCATION_ID = "J7y3jQR55TZrKEOB1yQ2";
const AUTH_ORIGIN = "https://app.olspsystem.com";
const FORMS_URL = `${AUTH_ORIGIN}/v2/location/${LOCATION_ID}/form-builder/main`;
const STORAGE_STATE_PATH = path.join(__dirname, "..", "browser-state", "ghl-storage-state.json");
const LOG_PATH = path.join(__dirname, "..", "debug", "browser-local-forms.log");
const DEFAULT_FOLDER_NAME = "..00.00 | Live Training - Dec25";
const DEFAULT_FORM_NAME = "Live Training | 01 | Tuesday - Dec25";
const FOLDER_WAIT_MS = 45000;
const TARGET_WAIT_MS = 20000;
const FAILURE_HOLD_MS = 10000;
const POST_DELETE_VERIFY_WAIT_MS = 3000;

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
fs.writeFileSync(LOG_PATH, "");

function log(message) {
  const line = String(message);
  console.log(line);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function visibleRows(page) {
  const locator = page.locator("table tbody tr, [role='row'], [aria-rowindex], [data-row-index], [data-index], [role='listitem']");
  const count = await locator.count().catch(() => 0);
  const rows = [];

  for (let index = 0; index < Math.min(count, 50); index += 1) {
    const row = locator.nth(index);
    if (!(await row.isVisible().catch(() => false))) {
      continue;
    }

    const text = String(await row.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (text) {
      rows.push({ row, text });
    }
  }

  return rows;
}

async function waitForFolderVisible(page, folderName, timeoutMs = FOLDER_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  const target = normalize(folderName);

  while (Date.now() < deadline) {
    const rows = await visibleRows(page);
    for (const entry of rows) {
      if (normalize(entry.text).includes(target)) {
        return Date.now();
      }
    }

    const bodyText = normalize(await page.locator("body").innerText().catch(() => ""));
    if (bodyText.includes(target)) {
      return Date.now();
    }

    await page.waitForTimeout(500);
  }

  return 0;
}

async function findRowByText(page, targetText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const target = normalize(targetText);

  while (Date.now() < deadline) {
    const rows = await visibleRows(page);
    for (const entry of rows) {
      if (normalize(entry.text).includes(target)) {
        return entry;
      }
    }

    await page.waitForTimeout(250);
  }

  return null;
}

async function clickTextInRow(row, text) {
  const escaped = String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const candidates = [
    row.getByText(text, { exact: false }).first(),
    row.getByRole("link", { name: new RegExp(escaped, "i") }).first(),
    row.getByRole("button", { name: new RegExp(escaped, "i") }).first(),
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click({ force: true });
      return true;
    }
  }

  await row.click({ force: true }).catch(() => {});
  return true;
}

async function findRowActions(row) {
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

async function findDeleteMenuItem(page, timeoutMs = 8000) {
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
        return candidate;
      }
    }

    await page.waitForTimeout(250);
  }

  return null;
}

async function confirmDeleteDialog(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const dialogs = page.locator('[role="dialog"], [aria-modal="true"]');
    const count = await dialogs.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) {
        continue;
      }

      const candidates = [
        dialog.getByRole("button", { name: /delete/i }).first(),
        dialog.getByRole("button", { name: /confirm/i }).first(),
        dialog.getByRole("button", { name: /yes/i }).first(),
        dialog.getByRole("button", { name: /remove/i }).first(),
        dialog.getByRole("button", { name: /^ok$/i }).first(),
      ];

      for (const candidate of candidates) {
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

  return false;
}

async function waitForRowAbsent(page, targetText, timeoutMs = TARGET_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  const target = normalize(targetText);

  while (Date.now() < deadline) {
    const rows = await visibleRows(page);
    const found = rows.some((entry) => normalize(entry.text).includes(target));
    if (!found) {
      return true;
    }

    await page.waitForTimeout(250);
  }

  return false;
}

async function refreshAndReopenFolder(page, folderName) {
  await page.goto(FORMS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  const folderVisibleAt = await waitForFolderVisible(page, folderName, FOLDER_WAIT_MS);
  if (!folderVisibleAt) {
    return { folderVisible: false, folderClicked: false };
  }

  const folderRow = await findRowByText(page, folderName, 5000);
  if (!folderRow) {
    return { folderVisible: true, folderClicked: false };
  }

  await clickTextInRow(folderRow.row, folderName);
  await page.waitForTimeout(1000);
  return { folderVisible: true, folderClicked: true };
}

async function main() {
  const startedAt = Date.now();
  const result = {
    folderVisible: false,
    folderVisibleAfterMs: 0,
    folderClicked: false,
    folderOpened: false,
    targetFound: false,
    actionsFound: false,
    deleteVisible: false,
    deleteClicked: false,
    confirmationCompleted: false,
    rowDisappeared: false,
    rowAbsentAfterRefresh: false,
    uiVerificationPassed: false,
    status: "failed",
    dryRunSuccess: false,
    runtimeMs: 0,
    error: "",
    currentUrl: "",
    bodyPreview: "",
  };

  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    throw new Error(`Storage state not found at ${STORAGE_STATE_PATH}`);
  }

  const browser = await chromium.launch({
    headless: false,
  });
  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH,
    viewport: null,
  });
  let page = null;

  try {
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);

    log("[FORM-LOCAL] launched");
    log("[FORM-LOCAL] storage state loaded");

    await page.goto(FORMS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    log("[FORM-LOCAL] navigated");
    result.currentUrl = page.url();

    const folderVisibleAt = await waitForFolderVisible(page, DEFAULT_FOLDER_NAME, FOLDER_WAIT_MS);
    if (!folderVisibleAt) {
      result.runtimeMs = Date.now() - startedAt;
      result.error = `Folder text did not appear within ${FOLDER_WAIT_MS}ms.`;
      result.bodyPreview = String(await page.locator("body").innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
      log("[FORM-LOCAL] FAIL step=folder_visible");
      log(JSON.stringify(result));
      await page.waitForTimeout(FAILURE_HOLD_MS);
      return;
    }

    result.folderVisible = true;
    result.folderVisibleAfterMs = folderVisibleAt - startedAt;
    log(`[FORM-LOCAL] folder visible after ${result.folderVisibleAfterMs}ms`);

    const folderRow = await findRowByText(page, DEFAULT_FOLDER_NAME, 5000);
    if (!folderRow) {
      result.runtimeMs = Date.now() - startedAt;
      result.error = `Folder row not found for "${DEFAULT_FOLDER_NAME}".`;
      log("[FORM-LOCAL] FAIL step=folder_row");
      log(JSON.stringify(result));
      await page.waitForTimeout(FAILURE_HOLD_MS);
      return;
    }

    await clickTextInRow(folderRow.row, DEFAULT_FOLDER_NAME);
    result.folderClicked = true;
    log("[FORM-LOCAL] folder clicked");

    const targetRow = await findRowByText(page, DEFAULT_FORM_NAME, TARGET_WAIT_MS);
    if (!targetRow) {
      result.runtimeMs = Date.now() - startedAt;
      result.error = `Exact form row not found for "${DEFAULT_FORM_NAME}".`;
      log("[FORM-LOCAL] FAIL step=target_found");
      log(JSON.stringify(result));
      await page.waitForTimeout(FAILURE_HOLD_MS);
      return;
    }

    result.folderOpened = true;
    result.targetFound = true;
    log("[FORM-LOCAL] folder opened");
    log("[FORM-LOCAL] target found");

    await targetRow.row.hover().catch(() => {});
    await page.waitForTimeout(350);

    const actionCandidate = await findRowActions(targetRow.row);
    if (!actionCandidate) {
      result.runtimeMs = Date.now() - startedAt;
      result.error = "Row-local Actions control was not found.";
      log("[FORM-LOCAL] FAIL step=actions");
      log(JSON.stringify(result));
      await page.waitForTimeout(FAILURE_HOLD_MS);
      return;
    }

    result.actionsFound = true;
    log("[FORM-LOCAL] Actions found");

    await actionCandidate.click({ timeout: 5000 }).catch((error) => {
      throw new Error(`Failed to open row actions: ${error.message}`);
    });
    await page.waitForTimeout(500);

    const deleteMenuItem = await findDeleteMenuItem(page, 8000);
    result.deleteVisible = Boolean(deleteMenuItem);
    if (!deleteMenuItem) {
      result.runtimeMs = Date.now() - startedAt;
      result.error = "Delete was not visible.";
      log("[FORM-LOCAL] FAIL step=delete_visible");
      log(JSON.stringify(result));
      await page.waitForTimeout(FAILURE_HOLD_MS);
      return;
    }

    log("[FORM-LOCAL] Delete visible");
    await deleteMenuItem.click({ timeout: 5000 }).catch((error) => {
      throw new Error(`Failed to click Delete: ${error.message}`);
    });
    result.deleteClicked = true;
    log("[FORM-LOCAL] Delete clicked");

    result.confirmationCompleted = await confirmDeleteDialog(page, 10000);
    if (!result.confirmationCompleted) {
      result.runtimeMs = Date.now() - startedAt;
      result.error = "Delete confirmation dialog was not confirmed.";
      log("[FORM-LOCAL] FAIL step=confirmation");
      log(JSON.stringify(result));
      await page.waitForTimeout(FAILURE_HOLD_MS);
      return;
    }
    log("[FORM-LOCAL] confirmation completed");

    result.rowDisappeared = await waitForRowAbsent(page, DEFAULT_FORM_NAME, TARGET_WAIT_MS);
    if (!result.rowDisappeared) {
      result.runtimeMs = Date.now() - startedAt;
      result.error = `Exact form row did not disappear for "${DEFAULT_FORM_NAME}".`;
      log("[FORM-LOCAL] FAIL step=row_disappeared");
      log(JSON.stringify(result));
      await page.waitForTimeout(FAILURE_HOLD_MS);
      return;
    }
    log("[FORM-LOCAL] row disappeared");

    await page.waitForTimeout(POST_DELETE_VERIFY_WAIT_MS);
    const reopened = await refreshAndReopenFolder(page, DEFAULT_FOLDER_NAME);
    if (!reopened.folderVisible || !reopened.folderClicked) {
      result.runtimeMs = Date.now() - startedAt;
      result.error = "Unable to reopen the folder after delete.";
      log("[FORM-LOCAL] FAIL step=refresh_reopen");
      log(JSON.stringify(result));
      await page.waitForTimeout(FAILURE_HOLD_MS);
      return;
    }

    result.rowAbsentAfterRefresh = await waitForRowAbsent(page, DEFAULT_FORM_NAME, TARGET_WAIT_MS);
    if (!result.rowAbsentAfterRefresh) {
      result.runtimeMs = Date.now() - startedAt;
      result.error = `Exact form row still appeared after refresh for "${DEFAULT_FORM_NAME}".`;
      log("[FORM-LOCAL] FAIL step=row_absent_after_refresh");
      log(JSON.stringify(result));
      await page.waitForTimeout(FAILURE_HOLD_MS);
      return;
    }
    log("[FORM-LOCAL] row absent after refresh");

    result.uiVerificationPassed = true;
    result.status = "deleted";
    result.dryRunSuccess = false;
    result.runtimeMs = Date.now() - startedAt;
    log("[FORM-LOCAL] DELETE SUCCESS");
    log(JSON.stringify(result));
  } catch (error) {
    result.runtimeMs = Date.now() - startedAt;
    result.error = String(error?.message || error);
    log(`[FORM-LOCAL] FAIL step=unknown error=${result.error}`);
    log(JSON.stringify(result));
    await page?.waitForTimeout(FAILURE_HOLD_MS).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(String(error?.stack || error?.message || error));
  process.exitCode = 1;
});
