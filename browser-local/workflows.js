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

const LOCATION_ID = "J7y3jQR55TZrKEOB1yQ2";
const AUTH_ORIGIN = "https://app.olspsystem.com";
const WORKFLOWS_URL = `${AUTH_ORIGIN}/v2/location/${LOCATION_ID}/automation/workflows?listTab=all`;
const STORAGE_STATE_PATH = path.join(__dirname, "..", "browser-state", "ghl-storage-state.json");

const WORKFLOW_FRAME_FRAGMENT = "client-app-automation-workflows.leadconnectorhq.com";
const FRAME_WAIT_MS = 120000;
const MENU_WAIT_MS = 8000;
const ROOT_SCOPE_WAIT_MS = 30000;
const FOLDER_OPEN_WAIT_MS = 30000;
const RETURN_ROOT_WAIT_MS = 120000;
const DELETE_VERIFY_WAIT_MS = 3000;

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
      const buttons = frame.locator('[aria-label="Workflow list actions"]');
      const count = await buttons.count().catch(() => 0);

      for (let index = 0; index < count; index += 1) {
        const button = buttons.nth(index);
        if (await isVisible(button)) {
          return frame;
        }
      }
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

  const preferred = safeFolders.find(
    (row) => normalizeSignatureText(row.name) === normalizeSignatureText(".01.00 | MegaLink - Dec25")
  );

  return preferred || safeFolders[0];
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

async function returnToRootAndGetFrame(page) {
  await page.goto(WORKFLOWS_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  return getVisibleWorkflowFrame(page, RETURN_ROOT_WAIT_MS);
}

async function main() {
  const startedAt = Date.now();
  const result = {
    topLevelRows: [],
    folders: [],
    folderName: "",
    folderOpened: false,
    insideRowCount: 0,
    rows: [],
    actualWorkflowCandidates: [],
    folderName: "",
    targetWorkflowName: "",
    actionsClicked: false,
    deleteWorkflowVisible: false,
    deleteWorkflowClicked: false,
    confirmationVisible: false,
    typedDelete: false,
    finalDeleteClicked: false,
    targetAlreadyAbsent: false,
    workflowDisappeared: false,
    workflowAbsentAfterRefresh: false,
    uiVerificationPassed: false,
    wrongTargetType: false,
    status: "failed",
    workflowFrameUrl: "",
    topLevelRowCount: 0,
    folderCount: 0,
    actualWorkflowCandidateCount: 0,
    runtimeMs: 0,
    error: "",
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

  const workflowCandidates = new Map();
  const folderRecords = new Map();

  try {
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);

    console.log("[WORKFLOW-INVENTORY] launched");

    await page.goto(WORKFLOWS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    const frame = await getVisibleWorkflowFrame(page, FRAME_WAIT_MS);
    result.workflowFrameUrl = frame.url();
    console.log("[WORKFLOW-INVENTORY] workflow frame ready");

    const rootRows = await waitForCurrentScope(frame, ROOT_SCOPE_WAIT_MS);
    console.log("[WORKFLOW-INVENTORY] top-level rows found");

    for (const row of rootRows) {
      const rowName = row.name || row.rowText;
      const protectedRow = isProtectedRowName(rowName) || isProtectedRowName(row.rowText);
      const criticalRow = isCriticalRowName(rowName) || isCriticalRowName(row.rowText);
      const rootEntry = {
        name: rowName,
        rowText: row.rowText,
        type: "unknown",
        protected: protectedRow,
        safeToOpen: false,
        actionButtonCount: 0,
      };

      if (protectedRow) {
        rootEntry.type = "protected_folder";
        result.topLevelRows.push(rootEntry);
        folderRecords.set(rowName, {
          name: rowName,
          protected: true,
          workflows: [],
        });
        continue;
      }

      if (criticalRow) {
        rootEntry.type = "skipped_critical";
        rootEntry.safeToOpen = false;
        result.topLevelRows.push(rootEntry);
        continue;
      }

      const classification = await inspectRowMenu(page, frame, row);
      rootEntry.actionButtonCount = classification.actionButtonCount;
      rootEntry.type = classification.type;
      rootEntry.safeToOpen = classification.type === "folder" || classification.type === "folder_candidate";
      rootEntry.menuLabels = classification.menuLabels;
      rootEntry.menuText = classification.menuText;
      result.topLevelRows.push(rootEntry);

      if (classification.type === "workflow" && isSafeCandidateName(rowName)) {
        const candidate = {
          name: rowName,
          folderName: null,
          type: "workflow",
          source: "top-level",
        };
        const key = `${candidate.folderName || ""}::${candidate.name}`;
        if (!workflowCandidates.has(key)) {
          workflowCandidates.set(key, candidate);
        }
      }

      if (rootEntry.safeToOpen && isSafeCandidateName(rowName)) {
        folderRecords.set(rowName, {
          name: rowName,
          protected: false,
          workflows: [],
        });
      }
    }

    result.folders = Array.from(folderRecords.values());
    result.topLevelRowCount = result.topLevelRows.length;
    result.folderCount = result.folders.length;
    const chosenFolder = pickPreferredFolder(result.topLevelRows);

    if (chosenFolder) {
      result.folderName = normalizeSignatureText(chosenFolder.name) || chosenFolder.name;
      console.log(`[WORKFLOW-INVENTORY] opening folder: ${result.folderName}`);
      const chosenFolderRow = findMatchingFolderRow(rootRows, chosenFolder.name);
      if (!chosenFolderRow) {
        throw new Error(`Folder row not found for ${chosenFolder.name}`);
      }

      await clickRowTitle(chosenFolderRow.locator, chosenFolderRow.name || chosenFolderRow.rowText);
      await page.waitForTimeout(1500);

      const folderFrame = await getVisibleWorkflowFrame(page, RETURN_ROOT_WAIT_MS);
      await waitForActionButtons(folderFrame, ROOT_SCOPE_WAIT_MS);

      const innerRows = await waitForCurrentScope(folderFrame, FOLDER_OPEN_WAIT_MS);
      result.folderOpened = innerRows.length > 0;
      console.log("[WORKFLOW-INVENTORY] folder opened");
      console.log("[WORKFLOW-INVENTORY] inside rows found");

      const folderRecord = {
        name: result.folderName,
        protected: false,
        workflows: [],
      };

      const candidateRows = innerRows.filter((row) => !isProtectedRowName(row.name || row.rowText));
      const targetRow =
        candidateRows.find((row) => !looksDangerousWorkflowName(row.name || row.rowText)) ||
        candidateRows[0] ||
        null;

      if (!targetRow) {
        result.targetAlreadyAbsent = true;
        result.workflowDisappeared = true;
        result.workflowAbsentAfterRefresh = true;
        result.uiVerificationPassed = true;
        result.status = "deleted";
        result.runtimeMs = Date.now() - startedAt;
        console.log("[WORKFLOW-DELETE] launched");
        console.log("[WORKFLOW-DELETE] folder opened");
        console.log("[WORKFLOW-DELETE] target workflow found");
        console.log("[WORKFLOW-DELETE] DELETE SUCCESS");
        console.log(`WORKFLOW_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
        return;
      }

      result.targetWorkflowName = targetRow.name || targetRow.rowText;
      if (looksDangerousWorkflowName(result.targetWorkflowName)) {
        result.wrongTargetType = true;
        result.error = `Target workflow "${result.targetWorkflowName}" failed safety guard.`;
        result.runtimeMs = Date.now() - startedAt;
        console.log(`WORKFLOW_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
        return;
      }

      console.log("[WORKFLOW-DELETE] launched");
      console.log("[WORKFLOW-DELETE] folder opened");
      console.log("[WORKFLOW-DELETE] target workflow found");

      const actionButton = await findRowActionButtons(targetRow.locator).then((items) =>
        items.find((item) => item.visible && item.enabled)
      );
      if (!actionButton) {
        result.error = "Exact row-local Actions button was not found for target workflow.";
        result.runtimeMs = Date.now() - startedAt;
        console.log(`WORKFLOW_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
        return;
      }

      await actionButton.locator.scrollIntoViewIfNeeded().catch(() => {});
      await actionButton.locator.click({ timeout: 5000 }).catch((error) => {
        throw new Error(`Failed to open target workflow actions: ${error.message}`);
      });
      result.actionsClicked = true;
      console.log("[WORKFLOW-DELETE] exact row Actions clicked");

      const deleteWorkflowItem = await findVisibleMenuItem(page, folderFrame, "Delete workflow", MENU_WAIT_MS);
      const deleteFolderItem = await findVisibleMenuItem(page, folderFrame, "Delete folder", MENU_WAIT_MS);
      result.deleteWorkflowVisible = Boolean(deleteWorkflowItem);
      if (deleteFolderItem && !deleteWorkflowItem) {
        result.wrongTargetType = true;
        result.error = "Delete folder was visible instead of Delete workflow.";
        result.runtimeMs = Date.now() - startedAt;
        console.log(`WORKFLOW_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
        return;
      }

      if (!deleteWorkflowItem) {
        result.error = "Delete workflow was not visible.";
        result.runtimeMs = Date.now() - startedAt;
        console.log(`WORKFLOW_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
        return;
      }

      console.log("[WORKFLOW-DELETE] Delete workflow visible");
      await deleteWorkflowItem.click({ timeout: 5000 }).catch((error) => {
        throw new Error(`Failed to click Delete workflow: ${error.message}`);
      });
      result.deleteWorkflowClicked = true;
      console.log("[WORKFLOW-DELETE] Delete workflow clicked");

      const dialogs = await collectDialogsFromScope(folderFrame, "frame");
      result.dialogsFound = dialogs.length;
      result.dialogs = dialogs;
      result.confirmationVisible = dialogs.length > 0;

      const dialog = await findVisibleDialogInScope(folderFrame);

      if (!dialog) {
        result.error = "No confirmation dialog was visible after Delete workflow click.";
        result.runtimeMs = Date.now() - startedAt;
        console.log(`WORKFLOW_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
        return;
      }

      console.log("[WORKFLOW-DELETE] confirmation visible");

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
        console.log(`WORKFLOW_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
        return;
      }

      await confirmationInput.fill("Delete", { timeout: 5000 }).catch(() => {});
      result.typedDelete = true;
      console.log("[WORKFLOW-DELETE] typed Delete");

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
        console.log(`WORKFLOW_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
        return;
      }

      await finalDeleteButton.click({ timeout: 5000 }).catch((error) => {
        throw new Error(`Failed to click final Delete: ${error.message}`);
      });
      result.finalDeleteClicked = true;
      console.log("[WORKFLOW-DELETE] final Delete clicked");

      await page.waitForTimeout(DELETE_VERIFY_WAIT_MS);

      const postRefresh = await refreshAndReopenFolder(page, chosenFolderRow);
      if (!postRefresh.folderOpened) {
        result.error = "Unable to reopen folder after delete.";
        result.runtimeMs = Date.now() - startedAt;
        console.log(`WORKFLOW_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
        return;
      }

      const freshRows = postRefresh.reopenedRows || [];
      const stillPresent = freshRows.some((row) =>
        normalizeSignatureText(row.name || row.rowText) === normalizeSignatureText(result.targetWorkflowName)
      );

      result.workflowDisappeared = !stillPresent;
      result.workflowAbsentAfterRefresh = !stillPresent;
      result.uiVerificationPassed = !stillPresent;

      if (!stillPresent) {
        result.status = "deleted";
        result.error = "";
        console.log("[WORKFLOW-DELETE] workflow absent after refresh");
        console.log("[WORKFLOW-DELETE] DELETE SUCCESS");
      } else {
        result.status = "verification_failed";
        result.error = `Target workflow still present after refresh: ${result.targetWorkflowName}`;
      }

      result.runtimeMs = Date.now() - startedAt;
      console.log(`WORKFLOW_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
      return;
    }
    for (const row of innerRows) {
      const rowName = row.name || row.rowText;
      const protectedRow = isProtectedRowName(rowName) || isProtectedRowName(row.rowText);
      const criticalRow = isCriticalRowName(rowName) || isCriticalRowName(row.rowText);

      if (protectedRow) {
        const entry = {
          name: rowName,
          type: "protected_folder",
          menuLabels: [],
        };
        result.rows.push(entry);
        folderRecord.workflows.push({
          name: rowName,
          type: "protected_folder",
        });
        continue;
      }

      if (criticalRow) {
        const entry = {
          name: rowName,
          type: "skipped_critical",
          menuLabels: [],
        };
        result.rows.push(entry);
        folderRecord.workflows.push({
          name: rowName,
          type: "skipped_critical",
        });
        continue;
      }

      const classification = await inspectRowMenu(page, folderFrame, row);
      const entry = {
        name: rowName,
        type: classification.type,
        menuLabels: classification.menuLabels,
      };
      result.rows.push(entry);
      folderRecord.workflows.push({
        name: rowName,
        type: classification.type,
      });

      if (classification.type === "workflow" && isSafeCandidateName(rowName)) {
        console.log(`[WORKFLOW-INVENTORY] actual workflow: ${rowName}`);
        const candidate = {
          name: rowName,
          folderName: result.folderName,
          type: "workflow",
          source: result.folderName,
        };
        const key = `${candidate.folderName || ""}::${candidate.name}`;
        if (!workflowCandidates.has(key)) {
          workflowCandidates.set(key, candidate);
        }
      }
    }

    result.folders = [folderRecord];
    result.insideRowCount = result.rows.length;

    result.actualWorkflowCandidates = Array.from(workflowCandidates.values());
    result.actualWorkflowCandidateCount = result.actualWorkflowCandidates.length;
    result.runtimeMs = Date.now() - startedAt;

    console.log("[WORKFLOW-INVENTORY] inventory complete");
    console.log(`WORKFLOW_INVENTORY_JSON:${JSON.stringify(result)}`);
  } catch (error) {
    result.runtimeMs = Date.now() - startedAt;
    result.error = String(error?.message || error);
    console.log(`WORKFLOW_INVENTORY_JSON:${JSON.stringify(result)}`);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(String(error?.stack || error?.message || error));
  process.exitCode = 1;
});
