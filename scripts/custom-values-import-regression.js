require("dotenv").config({ quiet: true });

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const XLSX = require("xlsx");
const {
  buildCustomValueInventory,
  classifyCustomValueRows,
  findCustomValueFolder,
  parseDelimitedText,
  parseWorkbookBuffer,
  verifyCustomValueFolderAssociation,
} = require("../web/services/customValuesImport");
const { ensureCustomValue, listCustomValues } = require("../web/services/customValuesApi");

function makeTempFile(name, buffer) {
  const filePath = path.join(os.tmpdir(), `${Date.now()}-${name}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function makeCustomValuesClientFactory(store, calls, options = {}) {
  const stripFolderAssociation = Boolean(options.stripFolderAssociation);
  return (config) => ({
    async get(url) {
      calls.push({ method: "get", url, headers: config.headers });
      if (url.endsWith("/customValues")) {
        return {
          data: {
            customValues: store.items.map((item) =>
              stripFolderAssociation
                ? { ...item, folderId: "", folderName: "" }
                : item
            ),
          },
        };
      }
      const match = url.match(/\/customValues\/([^/]+)$/);
      if (match) {
        const item = store.items.find((entry) => entry.id === decodeURIComponent(match[1]));
        if (!item) {
          const error = new Error("Not found");
          error.response = { status: 404, data: { message: "Not found" } };
          throw error;
        }
        return { data: { customValue: item } };
      }
      const error = new Error(`Unexpected GET ${url}`);
      error.response = { status: 404, data: { message: "Not found" } };
      throw error;
    },
    async post(url, body) {
      calls.push({ method: "post", url, body, headers: config.headers });
      const item = {
        id: `created-${store.items.length + 1}`,
        name: body.name,
        value: body.value,
        folderId: stripFolderAssociation ? "" : body.folderId || "",
        folderName: stripFolderAssociation ? "" : body.folderName || "",
      };
      store.items = [...store.items, item];
      return { data: { customValue: item } };
    },
    async patch(url, body) {
      calls.push({ method: "patch", url, body, headers: config.headers });
      const id = decodeURIComponent(url.split("/").filter(Boolean).pop());
      const item = store.items.find((entry) => entry.id === id);
      if (!item) {
        const error = new Error("Not found");
        error.response = { status: 404, data: { message: "Not found" } };
        throw error;
      }
      item.name = body.name;
      item.value = body.value;
      item.folderId = stripFolderAssociation ? "" : body.folderId || "";
      item.folderName = stripFolderAssociation ? "" : body.folderName || "";
      return { data: { customValue: item } };
    },
    async put(url, body) {
      return this.patch(url, body);
    },
  });
}

async function main() {
  const existing = buildCustomValueInventory([
    { id: "cv-1", name: "GHL Cleaner Test - CV 01", value: "one", folderName: "GHL Cleaner Test - CV Folder" },
    { id: "cv-2", name: "GHL Cleaner Test - CV 02", value: "two", folderName: "GHL Cleaner Test - CV Folder" },
    { id: "cv-3", name: "GHL Cleaner Test - CV 03", value: "three", folderName: "GHL Cleaner Test - CV Folder" },
  ]);

  const csvText = [
    "Name,Value,Folder",
    "GHL Cleaner Test - CV 01,one,GHL Cleaner Test - CV Folder",
    "GHL Cleaner Test - CV 02,two updated,GHL Cleaner Test - CV Folder",
    "GHL Cleaner Test - CV 04,four,GHL Cleaner Test - CV Folder",
  ].join("\n");

  const csvRows = parseDelimitedText(csvText);
  assert.strictEqual(csvRows.length, 3, "CSV should parse three data rows.");

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Name", "Value", "Folder"],
    ["GHL Cleaner Test - CV 01", "one", "GHL Cleaner Test - CV Folder"],
    ["GHL Cleaner Test - CV 02", "two updated", "GHL Cleaner Test - CV Folder"],
    ["GHL Cleaner Test - CV 03", "three", "GHL Cleaner Test - CV Folder"],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Import");
  const xlsxBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const xlsxPath = makeTempFile("custom-values-import.xlsx", xlsxBuffer);
  const parsedWorkbook = parseWorkbookBuffer(fs.readFileSync(xlsxPath));
  assert.strictEqual(parsedWorkbook.length, 3, "XLSX should parse three data rows.");

  const csvPreview = classifyCustomValueRows(csvRows, existing.items, "GHL Cleaner Test - CV Folder");
  const xlsxPreview = classifyCustomValueRows(parsedWorkbook, existing.items, "GHL Cleaner Test - CV Folder");
  const conflictPreview = classifyCustomValueRows(
    [{ name: "GHL Cleaner Test - CV 01", value: "one", folderName: "GHL Cleaner Test - CV Folder" }],
    [
      { id: "cv-a", name: "GHL Cleaner Test - CV 01", value: "one", folderName: "Folder A" },
      { id: "cv-b", name: "GHL Cleaner Test - CV 01", value: "one", folderName: "Folder B" },
    ],
    "GHL Cleaner Test - CV Folder"
  );

  assert.deepStrictEqual(
    csvPreview.counts,
    { create: 1, update: 1, unchanged: 1, conflict: 0, invalid: 0 },
    "CSV classification should identify create/update/unchanged rows."
  );
  assert.deepStrictEqual(
    xlsxPreview.counts,
    { create: 0, update: 1, unchanged: 2, conflict: 0, invalid: 0 },
    "XLSX classification should identify update and unchanged rows."
  );

  assert.strictEqual(
    csvPreview.rows.find((row) => row.name === "GHL Cleaner Test - CV 02")?.action,
    "UPDATE",
    "CSV preview should classify CV 02 as an update."
  );
  assert.strictEqual(
    xlsxPreview.rows.find((row) => row.name === "GHL Cleaner Test - CV 03")?.action,
    "UNCHANGED",
    "XLSX preview should classify CV 03 as unchanged."
  );
  assert.strictEqual(
    conflictPreview.rows[0]?.action,
    "CONFLICT",
    "Duplicate existing custom values should be classified as a conflict."
  );

  const folderInventory = buildCustomValueInventory([
    { id: "cv-1", name: "GHL Cleaner Test - CV 01", value: "one", folderId: "folder-1", folderName: "GHL Cleaner Test - CV Folder" },
  ]);
  const resolvedFolder = findCustomValueFolder(folderInventory, "GHL Cleaner Test - CV Folder");
  assert.strictEqual(resolvedFolder.folderId, "folder-1", "Folder lookup should reuse the real folder ID.");
  const associationCheck = verifyCustomValueFolderAssociation(folderInventory, "GHL Cleaner Test - CV Folder", "folder-1");
  assert.strictEqual(associationCheck.verified, true, "Folder association should verify from readback.");

  const store = {
    items: [
      { id: "cv-1", name: "GHL Cleaner Test - CV 01", value: "one", folderId: "folder-1", folderName: "GHL Cleaner Test - CV Folder" },
    ],
  };
  const calls = [];
  const clientFactory = makeCustomValuesClientFactory(store, calls);

  const unchanged = await ensureCustomValue("loc-1", "session-token", {
    name: "GHL Cleaner Test - CV 01",
    value: "one",
    folderId: "folder-1",
    folderName: "GHL Cleaner Test - CV Folder",
  }, { clientFactory });
  assert.strictEqual(unchanged.status, "unchanged", "Same values should stay unchanged.");

  const updated = await ensureCustomValue("loc-1", "session-token", {
    name: "GHL Cleaner Test - CV 01",
    value: "two updated",
    folderId: "folder-1",
    folderName: "GHL Cleaner Test - CV Folder",
  }, { clientFactory });
  assert.strictEqual(updated.status, "updated", "A changed value should update the existing record.");
  assert.strictEqual(store.items[0].value, "two updated", "The existing record should be updated in place.");
  assert.strictEqual(store.items.length, 1, "Updates must not create duplicates.");

  store.items = [
    { id: "cv-a", name: "GHL Cleaner Test - CV 02", value: "two", folderId: "folder-a", folderName: "Folder A" },
    { id: "cv-b", name: "GHL Cleaner Test - CV 02", value: "two", folderId: "folder-b", folderName: "Folder B" },
  ];
  const writesBeforeConflict = calls.filter((call) => ["post", "patch", "put"].includes(call.method)).length;
  const conflicted = await ensureCustomValue("loc-1", "session-token", {
    name: "GHL Cleaner Test - CV 02",
    value: "two",
    folderId: "folder-2",
    folderName: "GHL Cleaner Test - CV Folder",
  }, { clientFactory });
  assert.strictEqual(conflicted.status, "conflict", "Duplicate existing values should stop before writing.");
  const writesAfterConflict = calls.filter((call) => ["post", "patch", "put"].includes(call.method)).length;
  assert.strictEqual(writesAfterConflict, writesBeforeConflict, "Conflict classification must not write.");

  const badAssociationStore = {
    items: [],
  };
  const badAssociationCalls = [];
  const badAssociationClient = makeCustomValuesClientFactory(badAssociationStore, badAssociationCalls, {
    stripFolderAssociation: true,
  });
  const badAssociation = await ensureCustomValue("loc-1", "session-token", {
    name: "GHL Cleaner Test - CV 03",
    value: "three",
    folderId: "folder-1",
    folderName: "GHL Cleaner Test - CV Folder",
  }, { clientFactory: badAssociationClient });
  assert.strictEqual(badAssociation.status, "failed", "Writes must fail if folder association cannot be proven.");

  const sessionAuthHeaders = calls.find((call) => call.headers)?.headers || {};
  assert.strictEqual(sessionAuthHeaders.Authorization, "Bearer session-token", "Session credentials should be used in custom value requests.");

  console.log(
    `CUSTOM_VALUES_IMPORT_REGRESSION_JSON:${JSON.stringify({
      csvRows: csvRows.length,
      xlsxRows: parsedWorkbook.length,
      csvCounts: csvPreview.counts,
      xlsxCounts: xlsxPreview.counts,
      conflictAction: conflictPreview.rows[0]?.action || "",
      folderReuseVerified: true,
      unchangedPassed: unchanged.status === "unchanged",
      updatePassed: updated.status === "updated",
      conflictHandlingPassed: conflicted.status === "conflict",
      folderAssociationVerified: associationCheck.verified,
      associationFailureDetected: badAssociation.status === "failed",
      sessionCredentialUsed: true,
      previewPassed: true,
      xlsxPath,
    })}`
  );
}

main();
