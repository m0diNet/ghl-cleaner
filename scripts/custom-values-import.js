require("dotenv").config({ quiet: true });

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
  if (Array.isArray(payload.rows)) {
    return payload.rows;
  }

  const file = decodeFileData(payload);
  if (file.kind === "xlsx") {
    return parseWorkbookBuffer(file.buffer);
  }

  return parseDelimitedText(file.text);
}

async function main() {
  const startedAt = Date.now();
  const payload = parseImportPayload();
  const result = {
    success: false,
    mode: toText(payload.mode || "execute") || "execute",
    locationId: toText(payload.locationId || ""),
    targetFolderName: toText(payload.targetFolderName || payload.folderName || ""),
    inventoryLoaded: false,
    folderCreated: false,
    folderExisting: false,
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
    folderName: row.folderName ?? row.folder ?? row["Folder Name"] ?? row["Target Folder"] ?? "",
  }));

  const session = await openSessionWithLocalFallback();
  try {
    const context = session.context;
    const page = session.page || context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(90000);

    await openCustomValuesPage(page, result.locationId);
    const ready = await verifyCustomValuesPage(page);
    result.scopeUrl = ready.scopeUrl;
    result.pageReady = true;

    const token = toText(payload.token || "");
    if (!token) {
      throw new Error("Missing session token.");
    }

    const inventory = await listCustomValues(result.locationId, token);
    result.inventoryLoaded = true;
    const existingFolder = findCustomValueFolder(inventory, result.targetFolderName);
    result.folderExisting = Boolean(existingFolder);
    result.folderId = existingFolder?.folderId || "";
    const classification = classifyCustomValueRows(
      rows,
      inventory.items,
      result.targetFolderName
    );

    result.preview = classification.rows;
    result.counts = classification.counts;

    if (result.mode === "preview") {
      result.success = true;
      result.runtimeMs = Date.now() - startedAt;
      console.log(`CUSTOM_VALUES_IMPORT_RESULT_JSON:${JSON.stringify(result)}`);
      return;
    }

    if (result.targetFolderName) {
      const folderResult = await ensureFolder(page, result.targetFolderName);
      result.folderCreated = folderResult.status === "created";
      result.folderExisting = result.folderExisting || folderResult.status === "existing";
      if (folderResult.status === "failed") {
        result.verificationFailures.push(folderResult.error || "Folder creation failed.");
      }
    }

    for (const previewRow of classification.rows) {
      if (previewRow.action === "INVALID" || previewRow.action === "CONFLICT" || previewRow.action === "UNCHANGED") {
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
          folderName: previewRow.targetFolder || result.targetFolderName || "",
          folderId: result.folderId || previewRow.targetFolderId || "",
        });

        if (write.status === "created") {
          result.created += 1;
          if (write.folder?.folderId && !result.folderId) {
            result.folderId = write.folder.folderId;
          }
        } else if (write.status === "updated") {
          result.updated += 1;
          if (write.folder?.folderId && !result.folderId) {
            result.folderId = write.folder.folderId;
          }
        } else if (write.status === "unchanged") {
          result.unchanged += 1;
          result.skipped += 1;
        } else {
          result.failed += 1;
          result.verificationFailures.push(`Write failed: ${previewRow.name}`);
        }

        if (write.folderVerified === false) {
          result.failed += 1;
          result.verificationFailures.push(`Association not proven for ${previewRow.name}`);
        }
      } catch (error) {
        result.failed += 1;
        result.verificationFailures.push(`${previewRow.name}: ${error.message}`);
      }
    }

    const refreshed = await listCustomValues(result.locationId, token);
    const refreshedInventory = buildCustomValueInventory(refreshed.items);
    const folderNameTarget = toText(result.targetFolderName);
    const folderAssociation = verifyCustomValueFolderAssociation(
      refreshedInventory,
      folderNameTarget,
      result.folderId
    );
    const verifiedRows = classification.rows.filter((row) => row.action !== "INVALID" && row.action !== "CONFLICT");

    result.folderAssociationVerified = folderAssociation.verified;
    if (!folderAssociation.verified) {
      result.verificationFailures.push(...folderAssociation.failures);
    }

    const affected = verifiedRows.every((row) => {
      const match = refreshedInventory.items.find(
        (item) => String(item.name || "").toLowerCase() === String(row.name || "").toLowerCase()
      );
      if (!match) {
        result.verificationFailures.push(`Missing after write: ${row.name}`);
        return false;
      }
      if (!folderNameTarget) {
        return true;
      }
      return String(match.folderName || "").trim().toLowerCase() === folderNameTarget.trim().toLowerCase();
    });

    result.success = result.failed === 0 && result.verificationFailures.length === 0 && affected && result.folderAssociationVerified;
    result.runtimeMs = Date.now() - startedAt;
    console.log(`CUSTOM_VALUES_IMPORT_RESULT_JSON:${JSON.stringify(result)}`);
  } catch (error) {
    result.error = formatBrowserlessError(error);
    result.runtimeMs = Date.now() - startedAt;
    console.log(`CUSTOM_VALUES_IMPORT_RESULT_JSON:${JSON.stringify(result)}`);
    process.exitCode = 1;
  } finally {
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

const path = require("path");

if (require.main === module) {
  main().catch((error) => {
    console.error(formatBrowserlessError(error));
    process.exitCode = 1;
  });
}

module.exports = {
  decodeFileData,
  parseImportPayload,
  parseRowsFromPayload,
};
