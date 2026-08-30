require("dotenv").config({ quiet: true });

const path = require("path");
const { closeBrowserlessSession, formatBrowserlessError, saveBrowserlessStorageState } = require("../services/browserless");
const {
  buildCustomValueInventory,
  classifyCustomValueRows,
  findCustomValueFolder,
  parseDelimitedText,
  parseWorkbookBuffer,
  verifyCustomValueFolderAssociation,
  toText,
} = require("../web/services/customValuesImport");
const { ensureCustomValue, listCustomValues } = require("../web/services/customValuesApi");
const {
  ensureFolder,
  openCustomValuesPage,
  openSessionWithLocalFallback,
  moveCustomValueToFolder,
  verifyCustomValuesPage,
} = require("./ensure-custom-values");

function parseImportPayload() {
  try {
    const parsed = JSON.parse(process.env.CUSTOM_VALUES_IMPORT_JSON || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function decodeFileData(payload) {
  const fileName = toText(payload.fileName || payload.name || "");
  const fileType = toText(payload.fileType || payload.type || "");
  const text = toText(payload.fileText || payload.text || "");
  const base64 = toText(payload.fileBase64 || payload.base64 || "");

  if (/\.xlsx$/i.test(fileName) || /spreadsheet|excel/i.test(fileType)) {
    if (base64) {
      return { kind: "xlsx", buffer: Buffer.from(base64, "base64") };
    }
  }

  if (base64 && !text) {
    return { kind: "csv", text: Buffer.from(base64, "base64").toString("utf8") };
  }

  if (/\.xlsx$/i.test(fileName) || /spreadsheet|excel/i.test(fileType)) {
    return { kind: "xlsx", buffer: Buffer.from(text, "base64") };
  }

  return { kind: "csv", text };
}

function parseRowsFromPayload(payload) {
  const file = decodeFileData(payload);
  if (file.buffer || file.text) {
    if (file.kind === "xlsx") {
      return parseWorkbookBuffer(file.buffer);
    }
    return parseDelimitedText(file.text);
  }

  if (Array.isArray(payload.rows)) {
    return payload.rows;
  }

  return [];
}

async function loadCustomValueInventory(locationId, token, { clientFactory } = {}) {
  try {
    return await listCustomValues(locationId, token, { clientFactory });
  } catch (error) {
    const wrapped = new Error("API inventory failed.");
    wrapped.code = "API_INVENTORY_FAILED";
    wrapped.details = error?.message || String(error);
    wrapped.cause = error;
    throw wrapped;
  }
}

async function buildImportPreview({ locationId, token, rows, targetFolderName, fileMode, clientFactory } = {}) {
  const inventory = await loadCustomValueInventory(locationId, token, { clientFactory });
  const classification = classifyCustomValueRows(
    rows,
    inventory.items,
    fileMode ? "" : targetFolderName,
    { fileMode }
  );

  return {
    inventory,
    classification,
  };
}

async function main() {
  const startedAt = Date.now();
  const payload = parseImportPayload();
  let session = null;
  const result = {
    success: false,
    mode: toText(payload.mode || "execute") || "execute",
    locationId: toText(payload.locationId || ""),
    targetFolderName: toText(payload.targetFolderName || payload.folderName || ""),
    fileMode: Boolean(payload.fileName || payload.fileType || payload.fileText || payload.fileBase64),
    inventoryLoaded: false,
    folderCreated: false,
    folderExisting: false,
    folderStatus: "existing",
    folderAssociationVerified: false,
    folderId: "",
    preview: [],
    counts: {
      create: 0,
      update: 0,
      unchanged: 0,
      conflict: 0,
      invalid: 0,
    },
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    verificationFailures: [],
    runtimeMs: 0,
    error: "",
  };

  if (!result.locationId) {
    result.error = "Missing locationId.";
    result.runtimeMs = Date.now() - startedAt;
    console.log(`CUSTOM_VALUES_IMPORT_RESULT_JSON:${JSON.stringify(result)}`);
    process.exitCode = 1;
    return;
  }

  const rows = parseRowsFromPayload(payload).map((row) => ({
    name: row.name ?? row.Name ?? row["Custom Value Name"] ?? row.key ?? "",
    value: row.value ?? row.Value ?? "",
    folderId: row.folderId ?? row["Folder ID"] ?? row.parentId ?? "",
    folderName: row.folderName ?? row.folder ?? row["Folder Name"] ?? row["Target Folder"] ?? "",
  }));

  if (result.fileMode) {
    result.targetFolderName = "";
  }

  const token = toText(payload.token || "");
  if (!token) {
    result.error = "Missing session token.";
    result.runtimeMs = Date.now() - startedAt;
    console.log(`CUSTOM_VALUES_IMPORT_RESULT_JSON:${JSON.stringify(result)}`);
    process.exitCode = 1;
    return;
  }

  try {
    const { inventory, classification } = await buildImportPreview({
      locationId: result.locationId,
      token,
      rows,
      targetFolderName: result.targetFolderName,
      fileMode: result.fileMode,
    });
    result.inventoryLoaded = true;
    result.preview = classification.rows;
    result.counts = classification.counts;

    if (result.mode === "preview") {
      result.success = true;
      result.runtimeMs = Date.now() - startedAt;
      console.log(`CUSTOM_VALUES_IMPORT_RESULT_JSON:${JSON.stringify(result)}`);
      return;
    }

    const browserRows = classification.rows.filter(
      (row) => (row.action === "CREATE" || row.action === "UPDATE") &&
        row.targetFolder && row.folderStatus !== "EXISTING"
    );
    const folderNames = [...new Set(
      browserRows
        .map((row) => toText(row.targetFolder || ""))
        .filter(Boolean)
    )];
    const browserVerifiedRows = new Map();
    const rowStatuses = new Map();

    let page = null;
    if (browserRows.length) {
      session = await openSessionWithLocalFallback();
      const context = session.context;
      page = session.page || context.pages()[0] || (await context.newPage());
      page.setDefaultTimeout(30000);
      page.setDefaultNavigationTimeout(90000);

      result.pageReady = false;
      try {
        await openCustomValuesPage(page, result.locationId);
        const ready = await verifyCustomValuesPage(page);
        result.scopeUrl = ready.scopeUrl;
        result.pageReady = true;
      } catch (browserError) {
        const message = formatBrowserlessError(browserError);
        const lower = String(message || "").toLowerCase();
        if (lower.includes("browserless remote browser is unavailable")) {
          throw Object.assign(new Error("Browserless unavailable."), {
            code: "BROWSERLESS_UNAVAILABLE",
            details: message,
            cause: browserError,
          });
        }
        throw Object.assign(new Error("Local browser failed."), {
          code: "LOCAL_BROWSER_FAILED",
          details: message,
          cause: browserError,
        });
      }

      for (const folderName of folderNames) {
        const folderResult = await ensureFolder(page, folderName);
        result.folderCreated = result.folderCreated || folderResult.status === "created";
        result.folderExisting = result.folderExisting || folderResult.status === "existing";
        if (folderResult.status === "failed") {
          result.folderStatus = "failed";
        } else if (folderResult.status === "created" && result.folderStatus !== "failed") {
          result.folderStatus = "created";
        }
        if (folderResult.status === "failed") {
          result.verificationFailures.push(folderResult.error || `Folder creation failed for "${folderName}".`);
        }
      }
    }

    for (const previewRow of classification.rows) {
      if (previewRow.action === "INVALID" || previewRow.action === "CONFLICT" || previewRow.action === "UNCHANGED") {
        rowStatuses.set(previewRow.name, previewRow.action);
        if (previewRow.action === "UNCHANGED") {
          result.unchanged += 1;
          result.skipped += 1;
        } else if (previewRow.action === "INVALID" || previewRow.action === "CONFLICT") {
          result.failed += 1;
          result.verificationFailures.push(`${previewRow.action}: ${previewRow.name}`);
        }
        continue;
      }

      try {
        const write = await ensureCustomValue(result.locationId, token, {
          name: previewRow.name,
          value: previewRow.importedValue,
          folderName: previewRow.targetFolder || "",
          folderId: previewRow.targetFolderId || "",
        }, {
          associateFolder: async ({ item }) => {
            if (!previewRow.targetFolder) {
              return { moved: false, skipped: true };
            }
            const existingFolder = toText(previewRow.existingFolder || "");
            const targetFolder = toText(previewRow.targetFolder || "");
            if (previewRow.folderStatus === "EXISTING" ||
              (existingFolder && targetFolder && existingFolder.toLowerCase() === targetFolder.toLowerCase())) {
              return { moved: false, skipped: true };
            }
            if (!page) {
              throw new Error(`Browser verification is required to associate "${previewRow.name}" with a folder.`);
            }
            return moveCustomValueToFolder(
              page,
              item?.name || previewRow.name,
              targetFolder,
              item?.id || ""
            );
          },
        });
        rowStatuses.set(previewRow.name, write.status);

        if (write.status === "created") {
          result.created += 1;
        } else if (write.status === "updated") {
          result.updated += 1;
        } else if (write.status === "unchanged") {
          result.unchanged += 1;
          result.skipped += 1;
        } else {
          result.failed += 1;
          result.verificationFailures.push(`Write failed: ${previewRow.name}`);
        }
        browserVerifiedRows.set(previewRow.name, write.folderVerified === true);
      } catch (error) {
        rowStatuses.set(previewRow.name, "FAILED");
        result.failed += 1;
        result.verificationFailures.push(`${previewRow.name}: ${error.message}`);
      }
    }

    const refreshed = await listCustomValues(result.locationId, token);
    const refreshedInventory = buildCustomValueInventory(refreshed.items);
    const verifiedRows = classification.rows.filter((row) => {
      const status = rowStatuses.get(row.name);
      return status === "created" || status === "updated" || status === "unchanged";
    });

    let folderAssociationVerified = true;

    for (const row of verifiedRows) {
      const match = refreshedInventory.items.find(
        (item) => String(item.name || "").toLowerCase() === String(row.name || "").toLowerCase()
      );
      if (!match) {
        folderAssociationVerified = false;
        result.failed += 1;
        result.verificationFailures.push(`Missing after write: ${row.name}`);
        continue;
      }

      const expectedValue = String(row.importedValue || "");
      if (String(match.value || "") !== expectedValue) {
        folderAssociationVerified = false;
        result.failed += 1;
        result.verificationFailures.push(`Value mismatch after write: ${row.name}`);
        continue;
      }

      const expectedFolder = toText(row.targetFolder || "");
      if (!expectedFolder) {
        continue;
      }

      const browserVerified = browserVerifiedRows.get(row.name) === true;
      const folderMatches =
        (row.targetFolderId && String(match.folderId || "").trim() === String(row.targetFolderId).trim()) ||
        String(match.folderName || "").trim().toLowerCase() === expectedFolder.trim().toLowerCase();
      if (!browserVerified && !folderMatches) {
        folderAssociationVerified = false;
        result.failed += 1;
        result.verificationFailures.push(`Folder mismatch after write: ${row.name}`);
      }
    }

    result.folderAssociationVerified = folderAssociationVerified;
    result.success = result.failed === 0 && result.verificationFailures.length === 0 && result.folderAssociationVerified;
    result.runtimeMs = Date.now() - startedAt;
    console.log(`CUSTOM_VALUES_IMPORT_RESULT_JSON:${JSON.stringify(result)}`);
  } catch (error) {
    result.error = error.code || error.message || formatBrowserlessError(error);
    result.runtimeMs = Date.now() - startedAt;
    console.log(`CUSTOM_VALUES_IMPORT_RESULT_JSON:${JSON.stringify(result)}`);
    process.exitCode = 1;
  } finally {
    if (session) {
      await saveBrowserlessStorageState(
        session.context,
        String(
          process.env.BROWSER_STORAGE_STATE_PATH ||
            path.join(__dirname, "..", "browser-state", "ghl-storage-state.json")
        ).trim()
      ).catch(() => {});
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
  decodeFileData,
  buildImportPreview,
  parseImportPayload,
  parseRowsFromPayload,
};
