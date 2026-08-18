require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  cleanText,
  extractCanonicalRowName,
  getInventoryRowSelectors,
  isHeaderText,
  isPlaceholderText,
  looksLikeHeaderOnlyRow,
  normalizeSignatureText,
  rowLooksLikeFolder,
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
const FORMS_FRAME_FRAGMENT = "form-builder";
const FORMS_WAIT_MS = 30000;
const ROW_WAIT_MS = 15000;
const MENU_WAIT_MS = 8000;
const VERIFY_WAIT_MS = 3000;
const DEFAULT_FOLDER_OPEN_WAIT_MS = 1000;
const FORM_DRY_RUN = /^(1|true|yes)$/i.test(String(process.env.FORM_DRY_RUN || "").trim());
const AUTHENTICATED_LOCATION_ID = toText(process.env.GHL_LOCATION_ID || "");

function normalize(value) {
  return cleanText(value).toLowerCase();
}

function getFormsUrl(locationId) {
  return `${AUTH_ORIGIN}/v2/location/${locationId}/form-builder/main`;
}

function parseDeleteJobsJson(raw = process.env.DELETE_JOBS_JSON) {
  const text = toText(raw);
  if (!text) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.jobs)
      ? parsed.jobs
      : Array.isArray(parsed?.items)
        ? parsed.items
        : [];

  return normalizeDeleteJobs(items, "form").map((job) => ({
    ...job,
    resourceType: toText(job.resourceType || "form") || "form",
  }));
}

function selectSingleFormJob(jobs) {
  const parsedJobs = Array.isArray(jobs) ? jobs.filter(Boolean) : [];

  const formJobs = parsedJobs.filter((job) => normalize(job.resourceType) === "form");
  const unsupportedJobs = parsedJobs.filter((job) => normalize(job.resourceType) !== "form");

  if (formJobs.length !== 1) {
    return {
      job: null,
      jobReceived: parsedJobs.length > 0,
      targetResolvedBy: "",
      error:
        formJobs.length === 0
          ? unsupportedJobs.length
            ? `Unsupported delete job type(s): ${unsupportedJobs.map((job) => job.resourceType || "unknown").join(", ")}`
            : "No form job was provided."
          : `Expected exactly one form job, received ${formJobs.length}.`,
    };
  }

  const job = formJobs[0];
  const locationId = toText(job.locationId);
  if (!locationId) {
    return {
      job: null,
      jobReceived: true,
      targetResolvedBy: "",
      error: "Form job is missing locationId.",
    };
  }

  if (AUTHENTICATED_LOCATION_ID && locationId !== AUTHENTICATED_LOCATION_ID) {
    return {
      job: null,
      jobReceived: true,
      targetResolvedBy: "",
      error: "Form job location does not match the authenticated selected location.",
    };
  }

  return {
    job,
    jobReceived: true,
    targetResolvedBy: "",
    error: "",
  };
}

function buildResult(job) {
  return {
    jobReceived: Boolean(job),
    locationId: toText(job?.locationId),
    resourceId: toText(job?.resourceId),
    resourceName: toText(job?.resourceName),
    parentId: toText(job?.parentId),
    parentName: toText(job?.parentName),
    targetResolvedBy: "",
    folderResolved: false,
    folderResolvedBy: "",
    folderOpened: false,
    targetFound: false,
    resolvedRowName: "",
    resolvedResourceId: "",
    actionsFound: false,
    deleteVisible: false,
    deleteWouldBeAvailable: false,
    deleteClicked: false,
    confirmationCompleted: false,
    rowDisappeared: false,
    rowAbsentAfterRefresh: false,
    uiVerificationPassed: false,
    status: "failed",
    runtimeMs: 0,
    dryRun: FORM_DRY_RUN,
    error: "",
  };
}

function rowTexts(rowText) {
  return [cleanText(rowText), normalizeSignatureText(rowText), normalize(rowText)].filter(Boolean);
}

async function isVisible(locator) {
  return locator.isVisible().catch(() => false);
}

function getScopePage(scope) {
  return typeof scope.page === "function" ? scope.page() : scope;
}

async function collectRowCandidates(scope) {
  const rowsLocator = scope.locator(getInventoryRowSelectors().join(", "));
  const count = await rowsLocator.count().catch(() => 0);
  const seen = new Set();
  const rows = [];

  for (let index = 0; index < count; index += 1) {
    const row = rowsLocator.nth(index);
    if (!(await isVisible(row))) {
      continue;
    }

    const rowText = cleanText(await row.innerText().catch(() => ""));
    if (!rowText || isHeaderText(rowText) || looksLikeHeaderOnlyRow("forms", rowText)) {
      continue;
    }
    if (isPlaceholderText("forms", rowText)) {
      continue;
    }

    const box = await row.boundingBox().catch(() => null);
    const signature = [
      normalizeSignatureText(rowText),
      box
        ? `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}`
        : `row-${index}`,
    ].join("|");

    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);

    const directAttributes = await Promise.all([
      row.getAttribute("data-id").catch(() => ""),
      row.getAttribute("data-row-id").catch(() => ""),
      row.getAttribute("id").catch(() => ""),
      row.getAttribute("aria-label").catch(() => ""),
      row.getAttribute("title").catch(() => ""),
    ]);
    const link = row.locator("a[href]").first();
    const linkHref = await link.getAttribute("href").catch(() => "");
    const canonicalText = cleanText(await extractCanonicalRowName(row, "forms").catch(() => ""));
    const textCandidates = [
      canonicalText,
      rowText,
      ...rowTexts(rowText),
    ];
    const idCandidates = [
      ...directAttributes,
      linkHref,
    ]
      .map((value) => toText(value))
      .filter(Boolean);

    rows.push({
      locator: row,
      rowText,
      canonicalText,
      textCandidates,
      idCandidates,
      isFolder: rowLooksLikeFolder("forms", rowText),
    });
  }

  return rows;
}

async function findPrimaryScope(page, timeoutMs = FORMS_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const scopes = [page, ...page.frames().filter((frame) => String(frame.url() || "").includes(FORMS_FRAME_FRAGMENT))];

    for (const scope of scopes) {
      const rows = await collectRowCandidates(scope).catch(() => []);
      if (rows.length) {
        return scope;
      }
    }

    await page.waitForTimeout(250);
  }

  return page;
}

function exactMatchText(value, target) {
  return normalize(value) === normalize(target);
}

function rowMatchesJobName(row, resourceName) {
  const target = normalize(resourceName);
  if (!target) {
    return false;
  }

  return row.textCandidates.some((candidate) => exactMatchText(candidate, target));
}

function rowMatchesJobId(row, resourceId) {
  const target = normalize(resourceId);
  if (!target) {
    return false;
  }

  return row.idCandidates.some((candidate) => {
    const normalized = normalize(candidate);
    return normalized && (normalized === target || normalized.split(/[^a-z0-9_-]+/i).includes(target));
  });
}

function matchById(rows, resourceId) {
  const target = normalize(resourceId);
  if (!target) {
    return [];
  }

  return rows.filter((row) =>
    row.idCandidates.some((candidate) => {
      const normalized = normalize(candidate);
      if (!normalized) {
        return false;
      }
      if (normalized === target) {
        return true;
      }
      return normalized.split(/[^a-z0-9_-]+/i).includes(target);
    })
  );
}

function matchByExactName(rows, resourceName) {
  const target = normalize(resourceName);
  if (!target) {
    return [];
  }

  return rows.filter((row) =>
    row.textCandidates.some((candidate) => exactMatchText(candidate, target))
  );
}

function matchFolder(rows, parentId, parentName) {
  if (parentId) {
    const byId = matchById(rows, parentId).filter((row) => row.isFolder);
    if (byId.length) {
      return byId;
    }
  }

  if (parentName) {
    const byName = matchByExactName(rows, parentName).filter((row) => row.isFolder);
    if (byName.length) {
      return byName;
    }
  }

  return [];
}

function pickSingleMatch(matches, label) {
  if (matches.length === 1) {
    return { row: matches[0], error: "" };
  }

  if (matches.length > 1) {
    return { row: null, error: `Ambiguous ${label} match: ${matches.length} rows matched.` };
  }

  return { row: null, error: `No ${label} match was found.` };
}

async function clickRowTitle(row, targetLabel) {
  const candidates = [
    row.locator('a[href], [role="link"], [role="button"], button').filter({ hasText: targetLabel }).first(),
    row.locator('a[href], [role="link"], [role="button"], button').first(),
  ];

  for (const candidate of candidates) {
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

async function openFolderIfNeeded(scope, job) {
  const parentId = toText(job.parentId);
  const parentName = toText(job.parentName);

  if (!parentId && !parentName) {
    return { folderOpened: false, folderResolvedBy: "", scope, error: "" };
  }

  const rows = await collectRowCandidates(scope);
  const matches = matchFolder(rows, parentId, parentName);
  const selection = pickSingleMatch(matches, "folder");

  if (!selection.row) {
    return { folderOpened: false, folderResolvedBy: "", scope, error: selection.error || "Folder was not found." };
  }

  const folderName = selection.row.canonicalText || selection.row.rowText;
  await clickRowTitle(selection.row.locator, folderName);
  const page = getScopePage(scope);
  await page.waitForTimeout(DEFAULT_FOLDER_OPEN_WAIT_MS).catch(() => {});

  const reopenedScope = await findPrimaryScope(page, FORMS_WAIT_MS);
  return {
    folderOpened: true,
    folderResolvedBy: parentId ? "parentId" : "parentName",
    scope: reopenedScope,
    folderName,
    error: "",
  };
}

function pickTargetRow(rows, job) {
  const byId = matchById(rows, job.resourceId);
  const selectedById = pickSingleMatch(byId, "form id");
  if (selectedById.row) {
    if (job.resourceName && !rowMatchesJobName(selectedById.row, job.resourceName)) {
      return {
        row: null,
        targetResolvedBy: "resourceId",
        error: `Form id matched but the row name did not match "${job.resourceName}".`,
      };
    }
    return { row: selectedById.row, targetResolvedBy: "resourceId", error: "" };
  }
  if (byId.length > 1) {
    return { row: null, targetResolvedBy: "resourceId", error: selectedById.error };
  }

  const byName = matchByExactName(rows, job.resourceName);
  const selectedByName = pickSingleMatch(byName, "form name");
  if (selectedByName.row) {
    if (job.resourceId && rowMatchesJobId(selectedByName.row, job.resourceId) === false && selectedByName.row.idCandidates.some(Boolean)) {
      return {
        row: null,
        targetResolvedBy: "resourceName",
        error: `Form name matched but the row id did not match "${job.resourceId}".`,
      };
    }
    return { row: selectedByName.row, targetResolvedBy: "resourceName", error: "" };
  }
  if (byName.length > 1) {
    return { row: null, targetResolvedBy: "resourceName", error: selectedByName.error };
  }

  return {
    row: null,
    targetResolvedBy: "",
    error: `Unable to uniquely resolve form "${job.resourceName || job.resourceId || "unknown"}".`,
  };
}

async function findVisibleMenuItem(scope, labels, timeoutMs = MENU_WAIT_MS) {
  const page = getScopePage(scope);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const label of labels) {
      const candidates = [
        scope.getByRole("menuitem", { name: new RegExp(`^${label}$`, "i") }).first(),
        scope.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).first(),
        scope.getByText(new RegExp(`^${label}$`, "i")).first(),
        page.getByText(new RegExp(`^${label}$`, "i")).first(),
      ];

      for (const candidate of candidates) {
        if (await isVisible(candidate)) {
          return candidate;
        }
      }
    }

    await page.waitForTimeout(250);
  }

  return null;
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
    if (await isVisible(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function findDialog(scope) {
  const dialogs = scope.locator('[role="dialog"], [aria-modal="true"]');
  const count = await dialogs.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const dialog = dialogs.nth(index);
    if (await isVisible(dialog)) {
      return dialog;
    }
  }

  return null;
}

async function confirmDeleteDialog(scope) {
  const dialog = await findDialog(scope);
  if (!dialog) {
    return false;
  }

  const inputCandidates = [
    dialog.locator("input, textarea").first(),
    dialog.getByPlaceholder(/delete/i).first(),
    dialog.getByLabel(/delete/i).first(),
  ];

  for (const input of inputCandidates) {
    if (await isVisible(input)) {
      await input.fill("Delete", { timeout: 5000 }).catch(() => {});
      break;
    }
  }

  const finalDeleteCandidates = [
    dialog.getByRole("button", { name: /^Delete$/i }).first(),
    dialog.getByRole("button", { name: /delete/i }).first(),
    dialog.getByText(/^Delete$/i).first(),
  ];

  for (const candidate of finalDeleteCandidates) {
    if (await isVisible(candidate)) {
      await candidate.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }

  return false;
}

async function waitForRowAbsent(scope, job, timeoutMs = VERIFY_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  const page = getScopePage(scope);

  while (Date.now() < deadline) {
    const rows = await collectRowCandidates(scope);
    const match = pickTargetRow(rows, job);
    if (!match.row) {
      return true;
    }
    await page.waitForTimeout(250);
  }

  return false;
}

async function refreshAndVerify(page, job, folderOpened, folderName) {
  await page.reload({ waitUntil: "domcontentloaded", timeout: FORMS_WAIT_MS }).catch(() => {});
  await page.waitForTimeout(1500).catch(() => {});

  if (folderOpened && folderName) {
    const scope = await findPrimaryScope(page, FORMS_WAIT_MS);
    const rows = await collectRowCandidates(scope);
    const folderMatches = matchFolder(rows, job.parentId, folderName);
    const selection = pickSingleMatch(folderMatches, "folder");
    if (selection.row) {
      await clickRowTitle(selection.row.locator, selection.row.canonicalText || selection.row.rowText);
      await page.waitForTimeout(DEFAULT_FOLDER_OPEN_WAIT_MS).catch(() => {});
    }
  }

  const scope = await findPrimaryScope(page, FORMS_WAIT_MS);
  const absent = await waitForRowAbsent(scope, job, VERIFY_WAIT_MS);
  return { scope, absent };
}

async function runDryRun(page, scope, job, result) {
  const rows = await collectRowCandidates(scope);
  const targetSelection = pickTargetRow(rows, job);
  result.targetResolvedBy = targetSelection.targetResolvedBy;

  if (!targetSelection.row) {
    return {
      result,
      error: targetSelection.error || `Unable to resolve form target "${job.resourceName || job.resourceId}".`,
    };
  }

  result.targetFound = true;
  result.resolvedRowName = targetSelection.row.canonicalText || targetSelection.row.rowText;
  result.resolvedResourceId = targetSelection.row.idCandidates.find(Boolean) || "";

  const actionButton = await findRowActions(targetSelection.row.locator);
  if (!actionButton) {
    return { result, error: "Row-local Actions button was not found for the selected form." };
  }

  result.actionsFound = true;

  await actionButton.scrollIntoViewIfNeeded().catch(() => {});
  await actionButton.click({ timeout: 5000 }).catch((error) => {
    throw new Error(`Failed to open form actions: ${error.message}`);
  });

  const deleteItem = await findVisibleMenuItem(scope, ["Delete form", "Delete"]);
  result.deleteWouldBeAvailable = Boolean(deleteItem);

  return { result, error: "" };
}

async function main() {
  const startedAt = Date.now();
  const result = buildResult(null);
  let browser = null;

  try {
    const jobs = parseDeleteJobsJson(process.env.DELETE_JOBS_JSON);
    const selection = selectSingleFormJob(jobs);

    result.jobReceived = selection.jobReceived;
    result.locationId = toText(selection.job?.locationId);
    result.resourceId = toText(selection.job?.resourceId);
    result.resourceName = toText(selection.job?.resourceName);
    result.parentId = toText(selection.job?.parentId);
    result.parentName = toText(selection.job?.parentName);

    if (!selection.job) {
      result.error = selection.error || "No valid form job was provided.";
      result.runtimeMs = Date.now() - startedAt;
      console.log(`FORM_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    const job = selection.job;
    const locationId = toText(job.locationId);
    if (!locationId) {
      result.error = "Form job is missing locationId.";
      result.runtimeMs = Date.now() - startedAt;
      console.log(`FORM_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    if (AUTHENTICATED_LOCATION_ID && locationId !== AUTHENTICATED_LOCATION_ID) {
      result.error = "Form job location does not match the authenticated selected location.";
      result.runtimeMs = Date.now() - startedAt;
      console.log(`${FORM_DRY_RUN ? "FORM_TARGET_RESOLUTION_JSON" : "FORM_DELETE_RESULT_JSON"}:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    const formsUrl = getFormsUrl(locationId);
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      storageState: getStorageStatePath(),
      viewport: null,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);

    await page.goto(formsUrl, { waitUntil: "domcontentloaded", timeout: FORMS_WAIT_MS });
    let scope = await findPrimaryScope(page, FORMS_WAIT_MS);

    const folderResolution = await openFolderIfNeeded(scope, job);
    result.folderOpened = folderResolution.folderOpened;
    result.folderResolved = folderResolution.folderOpened;
    result.folderResolvedBy = folderResolution.folderResolvedBy || "";
    if (folderResolution.error) {
      result.error = folderResolution.error;
      result.runtimeMs = Date.now() - startedAt;
      console.log(`${FORM_DRY_RUN ? "FORM_TARGET_RESOLUTION_JSON" : "FORM_DELETE_RESULT_JSON"}:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    scope = folderResolution.scope;
    const folderName = folderResolution.folderName || job.parentName || "";

    if (FORM_DRY_RUN) {
      const dryRunOutcome = await runDryRun(page, scope, job, result);
      result.targetResolvedBy = dryRunOutcome.result.targetResolvedBy || selection.targetResolvedBy || "";
      result.status = dryRunOutcome.error ? "failed" : "resolved";
      result.error = dryRunOutcome.error;
      result.runtimeMs = Date.now() - startedAt;
      console.log(`FORM_TARGET_RESOLUTION_JSON:${JSON.stringify(result)}`);
      process.exitCode = dryRunOutcome.error ? 1 : 0;
      return;
    }

    const rows = await collectRowCandidates(scope);
    const targetSelection = pickTargetRow(rows, job);
    result.targetResolvedBy = targetSelection.targetResolvedBy || selection.targetResolvedBy || "";

    if (!targetSelection.row) {
      result.error = targetSelection.error || `Unable to resolve form target "${job.resourceName || job.resourceId}".`;
      result.runtimeMs = Date.now() - startedAt;
      console.log(`FORM_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    result.targetFound = true;
    result.resolvedRowName = targetSelection.row.canonicalText || targetSelection.row.rowText;
    result.resolvedResourceId = targetSelection.row.idCandidates.find(Boolean) || "";

    const actionButton = await findRowActions(targetSelection.row.locator);
    if (!actionButton) {
      result.error = "Row-local Actions button was not found for the selected form.";
      result.runtimeMs = Date.now() - startedAt;
      console.log(`FORM_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    await actionButton.scrollIntoViewIfNeeded().catch(() => {});
    await actionButton.click({ timeout: 5000 }).catch((error) => {
      throw new Error(`Failed to open form actions: ${error.message}`);
    });
    result.actionsFound = true;

    const deleteItem = await findVisibleMenuItem(scope, ["Delete form", "Delete"]);
    if (!deleteItem) {
      result.error = "Delete form was not visible.";
      result.runtimeMs = Date.now() - startedAt;
      console.log(`FORM_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    result.deleteVisible = true;
    result.deleteWouldBeAvailable = true;
    await deleteItem.click({ timeout: 5000 }).catch((error) => {
      throw new Error(`Failed to click Delete: ${error.message}`);
    });
    result.deleteClicked = true;

    result.confirmationCompleted = await confirmDeleteDialog(scope);
    if (!result.confirmationCompleted) {
      result.error = "Delete confirmation dialog was not completed.";
      result.runtimeMs = Date.now() - startedAt;
      console.log(`FORM_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
      process.exitCode = 1;
      return;
    }

    const initialAbsent = await waitForRowAbsent(scope, job, VERIFY_WAIT_MS);
    result.rowDisappeared = initialAbsent;

    const verification = await refreshAndVerify(page, job, result.folderOpened, folderName);
    result.rowAbsentAfterRefresh = verification.absent;
    result.uiVerificationPassed = result.rowDisappeared && result.rowAbsentAfterRefresh;
    result.status = result.uiVerificationPassed ? "deleted" : "verification_failed";
    result.error = result.uiVerificationPassed ? "" : "Target form still appears after refresh.";
    result.runtimeMs = Date.now() - startedAt;

    console.log(`FORM_DELETE_RESULT_JSON:${JSON.stringify(result)}`);
  } catch (error) {
    result.runtimeMs = Date.now() - startedAt;
    result.error = String(error?.message || error);
    result.status = "failed";
    console.log(`${FORM_DRY_RUN ? "FORM_TARGET_RESOLUTION_JSON" : "FORM_DELETE_RESULT_JSON"}:${JSON.stringify(result)}`);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  getFormsUrl,
  parseDeleteJobsJson,
  selectSingleFormJob,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(String(error?.stack || error?.message || error));
    process.exitCode = 1;
  });
}
