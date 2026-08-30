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
const { buildImportPreview } = require("./custom-values-import");

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
    { id: "cv-1", name: "GHL Cleaner Test - CV 01", value: "one", folderName: "GHL Cleaner Test - Gallery" },
    { id: "cv-2", name: "GHL Cleaner Test - CV 02", value: "two", folderName: "GHL Cleaner Test - Gallery" },
    { id: "cv-3", name: "GHL Cleaner Test - CV 03", value: "three", folderName: "GHL Cleaner Test - Gallery" },
  ]);

  const csvText = [
    "Name,Value,Folder",
    "GHL Cleaner Test - CV 01,one,GHL Cleaner Test - Gallery",
    "GHL Cleaner Test - CV 02,two updated,GHL Cleaner Test - Gallery",
    "GHL Cleaner Test - CV 03,three,GHL Cleaner Test - Gallery",
    "GHL Cleaner Test - CV 04,four,GHL Cleaner Test - Gallery",
    "GHL Cleaner Test - CV 05,five,GHL Cleaner Test - Gallery",
    "GHL Cleaner Test - CV 06,six,GHL Cleaner Test - Gallery",
  ].join("\n");

  const csvRows = parseDelimitedText(csvText);
  assert.strictEqual(csvRows.length, 6, "CSV should parse six data rows.");

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Name", "Value", "Folder"],
    ["GHL Cleaner Test - CV 01", "one", "GHL Cleaner Test - Gallery"],
    ["GHL Cleaner Test - CV 02", "two updated", "GHL Cleaner Test - Gallery"],
    ["GHL Cleaner Test - CV 03", "three", "GHL Cleaner Test - Gallery"],
    ["GHL Cleaner Test - CV 04", "four", "GHL Cleaner Test - Gallery"],
    ["GHL Cleaner Test - CV 05", "five", "GHL Cleaner Test - Gallery"],
    ["GHL Cleaner Test - CV 06", "six", "GHL Cleaner Test - Gallery"],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Import");
  const xlsxBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const xlsxPath = makeTempFile("GHL_Cleaner_Custom_Values_Test.xlsx", xlsxBuffer);
  const parsedWorkbook = parseWorkbookBuffer(fs.readFileSync(xlsxPath));
  assert.strictEqual(parsedWorkbook.length, 6, "XLSX should parse six data rows.");

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
  const fileModePreview = classifyCustomValueRows(
    parsedWorkbook,
    existing.items,
    "Manual Override",
    { fileMode: true }
  );
  const multiFolderExisting = buildCustomValueInventory([
    { id: "cv-1", name: "GHL Cleaner Test - CV 01", value: "one", folderName: "GHL Cleaner Test - Gallery" },
    { id: "cv-2", name: "GHL Cleaner Test - CV 02", value: "two", folderName: "GHL Cleaner Test - Gallery" },
    { id: "cv-3", name: "GHL Cleaner Test - CV 03", value: "three", folderName: "GHL Cleaner Test - Gallery" },
    { id: "cv-4", name: "GHL Cleaner Test - CV 04", value: "four", folderName: "Folder A" },
    { id: "cv-5", name: "GHL Cleaner Test - CV 05", value: "five", folderName: "Folder B" },
  ]);
  const mixedFolderRows = [
    { name: "GHL Cleaner Test - CV 01", value: "one", folderName: "GHL Cleaner Test - Gallery" },
    { name: "GHL Cleaner Test - CV 02", value: "two updated", folderName: "GHL Cleaner Test - Gallery" },
    { name: "GHL Cleaner Test - CV 03", value: "three", folderName: "GHL Cleaner Test - Gallery" },
    { name: "GHL Cleaner Test - CV 04", value: "four", folderName: "Folder A" },
    { name: "GHL Cleaner Test - CV 05", value: "five", folderName: "Folder B" },
    { name: "GHL Cleaner Test - CV 06", value: "six", folderName: "Folder B" },
  ];
  const mixedFolderPreview = classifyCustomValueRows(
    mixedFolderRows,
    multiFolderExisting.items,
    "Manual Override",
    { fileMode: true }
  );

  assert.deepStrictEqual(
    csvPreview.counts,
    { create: 3, update: 1, unchanged: 2, conflict: 0, invalid: 0 },
    "CSV classification should identify create/update/unchanged rows."
  );
  assert.deepStrictEqual(
    xlsxPreview.counts,
    { create: 3, update: 1, unchanged: 2, conflict: 0, invalid: 0 },
    "XLSX classification should identify update and unchanged rows."
  );

  const liveFolderId = "cGE5kGfKhHb0aCcWJJLQ";
  const liveRows = [
    ["GHL Cleaner Test - Gallery Section Label", "Updated Gallery Test Label 2"],
    ["GHL Cleaner Test - CV 02", "two"],
    ["GHL Cleaner Test - CV 03", "three"],
    ["GHL Cleaner Test - CV 04", "four"],
    ["GHL Cleaner Test - CV 05", "five"],
    ["GHL Cleaner Test - CV 06", "six"],
  ].map(([name, value]) => ({
    name,
    value,
    folderName: "GHL Cleaner Test - Gallery",
  }));
  const liveExisting = [
    ["GHL Cleaner Test - Gallery Section Label", "Updated Gallery Test Label"],
    ["GHL Cleaner Test - CV 02", "two"],
    ["GHL Cleaner Test - CV 03", "three"],
    ["GHL Cleaner Test - CV 04", "four"],
    ["GHL Cleaner Test - CV 05", "five"],
    ["GHL Cleaner Test - CV 06", "six"],
  ].map(([name, value], index) => ({
    id: `live-${index + 1}`,
    name,
    value,
    folderId: liveFolderId,
    folderName: "",
  }));
  const livePreview = classifyCustomValueRows(liveRows, liveExisting, "", { fileMode: true });
  assert.deepStrictEqual(
    livePreview.counts,
    { create: 0, update: 1, unchanged: 5, conflict: 0, invalid: 0 },
    "Known folder IDs should classify the live six-row import as one update and five unchanged rows."
  );
  assert.ok(
    livePreview.rows.every((row) => row.folderStatus === "EXISTING" && row.targetFolderId === liveFolderId),
    "Known folder IDs should remain authoritative when existing folder names are unavailable."
  );
  assert.strictEqual(
    livePreview.rows.find((row) => row.name === "GHL Cleaner Test - Gallery Section Label")?.action,
    "UPDATE",
    "The changed live row should remain an update."
  );
  assert.strictEqual(
    livePreview.rows.filter((row) => row.action === "UNCHANGED").length,
    5,
    "The five identical live rows should be unchanged."
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
  assert.ok(
    fileModePreview.rows.every((row) => row.targetFolder === "GHL Cleaner Test - Gallery"),
    "File mode should ignore manual folder overrides and keep the Excel folder values."
  );
  assert.strictEqual(
    fileModePreview.rows.find((row) => row.name === "GHL Cleaner Test - CV 01")?.folderStatus,
    "UNKNOWN_ID",
    "Preview should show UNKNOWN_ID when the folder exists but no folder ID is exposed."
  );
  assert.strictEqual(
    classifyCustomValueRows(
      [{ name: "GHL Cleaner Test - CV 99", value: "ninety-nine", folderName: "Brand New Folder" }],
      [],
      "",
      { fileMode: true }
    ).rows[0]?.folderStatus,
    "CREATE",
    "Preview should mark a brand new folder as CREATE."
  );
  assert.strictEqual(
    mixedFolderPreview.rows.find((row) => row.name === "GHL Cleaner Test - CV 04")?.targetFolder,
    "Folder A",
    "Multiple folders in one Excel import should keep each row's folder."
  );
  assert.strictEqual(
    mixedFolderPreview.rows.find((row) => row.name === "GHL Cleaner Test - CV 05")?.targetFolder,
    "Folder B",
    "Multiple folders in one Excel import should keep each row's folder."
  );
  assert.strictEqual(
    conflictPreview.rows[0]?.action,
    "CONFLICT",
    "Duplicate existing custom values should be classified as a conflict."
  );

  const folderInventory = buildCustomValueInventory([
    { id: "cv-1", name: "GHL Cleaner Test - CV 01", value: "one", folderId: "folder-1", folderName: "GHL Cleaner Test - Gallery" },
  ]);
  const resolvedFolder = findCustomValueFolder(folderInventory, "GHL Cleaner Test - Gallery");
  assert.strictEqual(resolvedFolder.folderId, "folder-1", "Folder lookup should reuse the real folder ID.");
  const associationCheck = verifyCustomValueFolderAssociation(folderInventory, "GHL Cleaner Test - Gallery", "folder-1");
  assert.strictEqual(associationCheck.verified, true, "Folder association should verify from readback.");

  const store = {
    items: [
      { id: "cv-1", name: "GHL Cleaner Test - CV 01", value: "one", folderId: "folder-1", folderName: "GHL Cleaner Test - Gallery" },
    ],
  };
  const calls = [];
  const clientFactory = makeCustomValuesClientFactory(store, calls);
  const associationCalls = [];
  const associateFolder = async ({ desiredFolder, item }) => {
    associationCalls.push({ item: item.name, folder: desiredFolder.folderName, phase: item.id ? "update" : "create" });
    const folderId = desiredFolder?.folderId || "";
    const folderName = desiredFolder?.folderName || "";
    const target = store.items.find((entry) => String(entry.name || "").toLowerCase() === String(item.name || "").toLowerCase());
    if (!target) {
      throw new Error(`Unable to associate folder for ${item.name}`);
    }
    target.folderId = folderId;
    target.folderName = folderName;
    return { moved: true };
  };

  const unchanged = await ensureCustomValue("loc-1", "session-token", {
    name: "GHL Cleaner Test - CV 01",
    value: "one",
    folderId: "folder-1",
    folderName: "GHL Cleaner Test - Gallery",
  }, { clientFactory, associateFolder });
  assert.strictEqual(unchanged.status, "unchanged", "Same values should stay unchanged.");
  assert.strictEqual(associationCalls.length, 0, "Unchanged values should not invoke folder association.");

  const updated = await ensureCustomValue("loc-1", "session-token", {
    name: "GHL Cleaner Test - CV 01",
    value: "two updated",
    folderId: "folder-1",
    folderName: "GHL Cleaner Test - Gallery",
  }, { clientFactory, associateFolder });
  assert.strictEqual(updated.status, "updated", "A changed value should update the existing record.");
  assert.strictEqual(store.items[0].value, "two updated", "The existing record should be updated in place.");
  assert.strictEqual(store.items.length, 1, "Updates must not create duplicates.");
  assert.deepStrictEqual(
    associationCalls[0],
    { item: "GHL Cleaner Test - CV 01", folder: "GHL Cleaner Test - Gallery", phase: "update" },
    "Updates must associate the exact existing Custom Value with the requested folder."
  );

  store.items = [
    { id: "cv-a", name: "GHL Cleaner Test - CV 02", value: "two", folderId: "folder-a", folderName: "Folder A" },
    { id: "cv-b", name: "GHL Cleaner Test - CV 02", value: "two", folderId: "folder-b", folderName: "Folder B" },
  ];
  const writesBeforeConflict = calls.filter((call) => ["post", "patch", "put"].includes(call.method)).length;
  const conflicted = await ensureCustomValue("loc-1", "session-token", {
    name: "GHL Cleaner Test - CV 02",
    value: "two",
    folderId: "folder-2",
    folderName: "GHL Cleaner Test - Gallery",
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
    folderName: "GHL Cleaner Test - Gallery",
  }, { clientFactory: badAssociationClient });
  assert.strictEqual(badAssociation.status, "failed", "Writes must fail if folder association cannot be proven.");

  const writeCalls = calls.filter((call) => ["post", "patch", "put"].includes(call.method));
  assert.ok(writeCalls.length > 0, "The regression should capture write calls.");
  assert.ok(
    writeCalls.every((call) => JSON.stringify(Object.keys(call.body).sort()) === JSON.stringify(["name", "value"])),
    "Write payloads should only send name and value."
  );

  const previewStore = {
    items: [
      { id: "cv-1", name: "GHL Cleaner Test - CV 01", value: "one", folderName: "GHL Cleaner Test - Gallery" },
      { id: "cv-2", name: "GHL Cleaner Test - CV 02", value: "two", folderName: "GHL Cleaner Test - Gallery" },
      { id: "cv-3", name: "GHL Cleaner Test - CV 03", value: "three", folderName: "GHL Cleaner Test - Gallery" },
    ],
  };
  const previewCalls = [];
  const previewClientFactory = makeCustomValuesClientFactory(previewStore, previewCalls);
  const apiOnlyPreview = await buildImportPreview({
    locationId: "loc-1",
    token: "session-token",
    rows: parsedWorkbook,
    targetFolderName: "Manual Override",
    fileMode: true,
    clientFactory: previewClientFactory,
  });
  assert.strictEqual(apiOnlyPreview.classification.rows.length, 6, "API-first preview should preserve all parsed rows.");
  assert.ok(
    apiOnlyPreview.classification.rows.every((row) => row.targetFolder === "GHL Cleaner Test - Gallery"),
    "API-first preview should ignore manual folder overrides in file mode."
  );
  assert.strictEqual(
    previewCalls.some((call) => call.method === "get"),
    true,
    "API-first preview should only need the Custom Values API."
  );

  const fileImportStore = { items: [] };
  const fileImportCalls = [];
  const fileImportClient = makeCustomValuesClientFactory(fileImportStore, fileImportCalls);
  const fileAssociateFolder = async ({ desiredFolder, item }) => {
    const folderId = desiredFolder?.folderId || "";
    const folderName = desiredFolder?.folderName || "";
    const target = fileImportStore.items.find((entry) => String(entry.name || "").toLowerCase() === String(item.name || "").toLowerCase());
    if (!target) {
      throw new Error(`Unable to associate folder for ${item.name}`);
    }
    target.folderId = folderId;
    target.folderName = folderName;
    return { moved: true };
  };
  const fileImportRows = [
    { name: "GHL Cleaner Test - CV 01", value: "one", folderName: "GHL Cleaner Test - Gallery" },
    { name: "GHL Cleaner Test - CV 02", value: "two updated", folderName: "GHL Cleaner Test - Gallery" },
    { name: "GHL Cleaner Test - CV 03", value: "three", folderName: "Folder A" },
    { name: "GHL Cleaner Test - CV 04", value: "four", folderName: "Folder A" },
    { name: "GHL Cleaner Test - CV 05", value: "five", folderName: "Folder B" },
    { name: "GHL Cleaner Test - CV 06", value: "six", folderName: "Folder B" },
  ];

  const runFileImport = async (rows) => {
    const results = [];
    for (const row of rows) {
      results.push(await ensureCustomValue("loc-1", "session-token", {
        name: row.name,
        value: row.value,
        folderName: row.folderName,
      }, { clientFactory: fileImportClient, associateFolder: fileAssociateFolder }));
    }
    return results;
  };

  const firstImport = await runFileImport(fileImportRows);
  assert.ok(firstImport.every((result) => result.status === "created"), "The first file import should create every row.");
  assert.strictEqual(fileImportStore.items.length, 6, "The first file import should create six values.");

  const secondImport = await runFileImport(fileImportRows);
  assert.ok(secondImport.every((result) => result.status === "unchanged"), "The same file imported twice should be unchanged.");
  assert.strictEqual(fileImportStore.items.length, 6, "Re-importing the same file must not create duplicates.");

  const thirdImportRows = fileImportRows.map((row) =>
    row.name === "GHL Cleaner Test - CV 02"
      ? { ...row, value: "two newer" }
      : row
  );
  const thirdImport = await runFileImport(thirdImportRows);
  assert.strictEqual(
    thirdImport.find((result) => result.before?.name === "GHL Cleaner Test - CV 02")?.status,
    "updated",
    "A changed row in the file should update the existing value."
  );
  assert.strictEqual(fileImportStore.items.length, 6, "Updates must not create duplicates.");

  const fileInventory = buildCustomValueInventory(fileImportStore.items);
  const fileFolderCheck = verifyCustomValueFolderAssociation(fileInventory, "GHL Cleaner Test - Gallery");
  assert.strictEqual(fileFolderCheck.verified, true, "Folder association should verify after file imports.");

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
      fileFolderAssociationVerified: fileFolderCheck.verified,
      associationFailureDetected: badAssociation.status === "failed",
      sessionCredentialUsed: true,
      duplicatePreventionPassed: fileImportStore.items.length === 6,
      previewPassed: true,
      xlsxPath,
    })}`
  );
}

main();
