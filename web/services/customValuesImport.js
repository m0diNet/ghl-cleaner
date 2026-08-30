const XLSX = require("xlsx");

const HEADER_ALIASES = new Map([
  ["name", "name"],
  ["custom value name", "name"],
  ["custom value", "name"],
  ["key", "name"],
  ["value", "value"],
  ["custom value value", "value"],
  ["folder", "folderName"],
  ["folder name", "folderName"],
  ["target folder", "folderName"],
]);

function toText(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return toText(value).replace(/\s+/g, " ").toLowerCase();
}

function normalizeName(value) {
  return toText(value).replace(/\s+/g, " ").trim();
}

function normalizeHeader(value) {
  return normalize(value);
}

function canonicalHeaderKey(value) {
  return HEADER_ALIASES.get(normalizeHeader(value)) || normalizeHeader(value);
}

function parseCsvText(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let current = [];
  let cell = "";
  let quoted = false;

  const pushCell = () => {
    current.push(cell);
    cell = "";
  };

  const pushRow = () => {
    if (current.length || cell.length) {
      if (cell.length) {
        pushCell();
      }
      rows.push(current);
    }
    current = [];
    cell = "";
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
        continue;
      }

      if (char === '"') {
        quoted = false;
        continue;
      }

      cell += char;
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }

    if (char === ",") {
      pushCell();
      continue;
    }

    if (char === "\r") {
      continue;
    }

    if (char === "\n") {
      pushRow();
      continue;
    }

    cell += char;
  }

  if (cell.length || current.length) {
    pushRow();
  }

  return rows;
}

function rowsToObjects(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return [];
  }

  const headerRow = rows[0].map((cell) => canonicalHeaderKey(cell));
  const objects = [];

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const entry = {};

    for (let columnIndex = 0; columnIndex < headerRow.length; columnIndex += 1) {
      const key = headerRow[columnIndex];
      if (!key) {
        continue;
      }
      entry[key] = row[columnIndex] ?? "";
    }

    objects.push(entry);
  }

  return objects;
}

function parseDelimitedText(text) {
  return rowsToObjects(parseCsvText(text));
}

function parseWorkbookBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellText: true, cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return [];
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: false });
  return rowsToObjects(rows);
}

function normalizeExistingCustomValue(item) {
  return {
    id: toText(item?.id || item?._id || item?.customValueId),
    name: normalizeName(item?.name || item?.key || item?.fieldKey),
    value: toText(item?.value),
    folderId: toText(item?.folderId || item?.parentId) || null,
    folderName: toText(item?.folderName || item?.parentName || item?.folder || "") || null,
    metadata: item?.metadata && typeof item.metadata === "object" ? { ...item.metadata } : {},
    raw: item,
  };
}

function normalizeImportRow(row, options = {}) {
  const {
    fallbackFolderName = "",
    requireFolder = false,
  } = options && typeof options === "object" ? options : {};
  const source = row && typeof row === "object" ? row : {};
  const name = normalizeName(source.name || source.key || source.fieldKey);
  const value = toText(source.value);
  const folderId = toText(source.folderId || source.parentId || "");
  const folderName = normalizeName(source.folderName || fallbackFolderName || "");

  const invalid = !name || (requireFolder && !folderName);
  return {
    name,
    value,
    folderId: folderId || null,
    folderName: folderName || null,
    raw: source,
    invalid,
  };
}

function getRowFolderTarget(row, fallbackFolderName = "") {
  return normalizeName(row.folderName || fallbackFolderName || "") || null;
}

function classifyCustomValueRows(importRows, existingItems, fallbackFolderName = "", options = {}) {
  const {
    fileMode = false,
    requireFolder = fileMode,
  } = options && typeof options === "object" ? options : {};
  const normalizedExisting = (Array.isArray(existingItems) ? existingItems : [])
    .map(normalizeExistingCustomValue)
    .filter((item) => item.id && item.name);

  const existingByName = new Map();

  for (const item of normalizedExisting) {
    const key = normalize(item.name);
    const list = existingByName.get(key) || [];
    list.push(item);
    existingByName.set(key, list);
  }

  const previewRows = [];
  let create = 0;
  let update = 0;
  let unchanged = 0;
  let conflict = 0;
  let invalid = 0;

  for (const importRow of Array.isArray(importRows) ? importRows : []) {
    const row = normalizeImportRow(importRow, {
      fallbackFolderName: fileMode ? "" : fallbackFolderName,
      requireFolder,
    });
    const targetFolder = getRowFolderTarget(row, fileMode ? "" : fallbackFolderName);
    const matchingFolderItems = targetFolder
      ? normalizedExisting.filter(
        (item) => normalizeName(item.folderName || "") === normalizeName(targetFolder)
      )
      : [];
    const preliminaryFolderStatus = !targetFolder
      ? "INVALID"
      : matchingFolderItems.some((item) => item.folderId)
        ? "EXISTING"
        : matchingFolderItems.length
          ? "UNKNOWN_ID"
          : "UNKNOWN";

    if (row.invalid) {
      invalid += 1;
      previewRows.push({
        action: "INVALID",
        name: row.name || "",
        existingValue: "",
        importedValue: row.value || "",
        existingFolder: "",
        targetFolder,
        folderStatus: preliminaryFolderStatus,
        existingId: "",
        targetFolderId: "",
        reason: requireFolder ? "Missing required name or folder." : "Missing required name.",
        raw: row.raw,
      });
      continue;
    }

    const matches = existingByName.get(normalize(row.name)) || [];

    if (matches.length > 1) {
      conflict += 1;
      previewRows.push({
        action: "CONFLICT",
        name: row.name,
        existingValue: "",
        importedValue: row.value,
        existingFolder: "",
        targetFolder,
        folderStatus: preliminaryFolderStatus,
        existingId: "",
        targetFolderId: "",
        reason: "Multiple existing Custom Values match this name.",
        raw: row.raw,
      });
      continue;
    }

    const existing = matches[0] || null;
    const desiredFolder = targetFolder || existing?.folderName || null;
    const catalogTargetFolderId = matchingFolderItems.find((item) => item.folderId)?.folderId || "";
    const targetFolderId =
      row.folderId ||
      catalogTargetFolderId ||
      (existing && !matchingFolderItems.length ? existing.folderId || "" : "");
    const folderStatus = !targetFolder
      ? "INVALID"
      : targetFolderId
        ? "EXISTING"
        : matchingFolderItems.length
          ? "UNKNOWN_ID"
          : existing
            ? "UNKNOWN"
            : "CREATE";
    const folderChanged = Boolean(existing) && Boolean(desiredFolder) && (
      targetFolderId && existing.folderId
        ? existing.folderId !== targetFolderId
        : Boolean(existing.folderName) && Boolean(targetFolder) &&
          normalize(existing.folderName) !== normalize(targetFolder)
    );
    const valueChanged = Boolean(existing) && String(existing.value || "") !== String(row.value || "");

    if (!existing) {
      create += 1;
      previewRows.push({
        action: "CREATE",
        name: row.name,
        existingValue: "",
        importedValue: row.value,
        existingFolder: "",
        targetFolder: desiredFolder,
        folderStatus,
        existingId: "",
        targetFolderId,
        reason: "",
        raw: row.raw,
      });
      continue;
    }

    if (!valueChanged && !folderChanged) {
      unchanged += 1;
      previewRows.push({
        action: "UNCHANGED",
        name: row.name,
        existingValue: existing.value,
        importedValue: row.value,
        existingFolder: existing.folderName || "",
        targetFolder: desiredFolder,
        folderStatus,
        existingId: existing.id,
        targetFolderId,
        reason: "",
        raw: row.raw,
      });
      continue;
    }

    update += 1;
    previewRows.push({
      action: "UPDATE",
      name: row.name,
      existingValue: existing.value,
      importedValue: row.value,
      existingFolder: existing.folderName || "",
      targetFolder: desiredFolder,
      folderStatus,
      existingId: existing.id,
      targetFolderId,
      reason: "",
      raw: row.raw,
    });
  }

  return {
    rows: previewRows,
    counts: {
      create,
      update,
      unchanged,
      conflict,
      invalid,
    },
    normalizedExisting,
  };
}

function extractCustomValueItems(data) {
  if (Array.isArray(data?.customValues)) return data.customValues;
  if (Array.isArray(data?.values)) return data.values;
  if (Array.isArray(data?.data?.customValues)) return data.data.customValues;
  if (Array.isArray(data?.data?.values)) return data.data.values;
  if (Array.isArray(data)) return data;
  return [];
}

function buildCustomValueInventory(items, folderRecords = []) {
  const normalized = (Array.isArray(items) ? items : []).map(normalizeExistingCustomValue);
  const folders = [];
  const seen = new Set();

  for (const rawFolder of Array.isArray(folderRecords) ? folderRecords : []) {
    const folderId = toText(rawFolder?.folderId || rawFolder?.id || rawFolder?._id);
    const folderName = toText(rawFolder?.folderName || rawFolder?.name || rawFolder?.title);
    if (!folderId && !folderName) {
      continue;
    }
    const folderKey = folderId ? `id:${folderId}` : `name:${normalize(folderName)}`;
    if (seen.has(folderKey)) {
      continue;
    }
    seen.add(folderKey);
    folders.push({
      folderId,
      folderName,
      folderNameResolved: Boolean(folderName),
      source: "folder-catalog",
    });
  }

  for (const item of normalized) {
    const folderId = toText(item.folderId);
    const folderName = toText(item.folderName);
    if (!folderId && !folderName) {
      continue;
    }
    const folderKey = folderId ? `id:${folderId}` : `name:${normalize(folderName)}`;
    if (seen.has(folderKey)) {
      continue;
    }
    seen.add(folderKey);
    folders.push({
      folderId,
      folderName,
      folderNameResolved: Boolean(folderName),
      source: "custom-value-association",
    });
  }

  return {
    items: normalized,
    folders,
    folderCatalogAvailable: Array.isArray(folderRecords) && folderRecords.length > 0,
  };
}

function findCustomValueFolder(inventoryOrItems, folderName, folderId = "") {
  const inventory = Array.isArray(inventoryOrItems)
    ? buildCustomValueInventory(inventoryOrItems)
    : inventoryOrItems && typeof inventoryOrItems === "object"
      ? inventoryOrItems
      : { items: [], folders: [] };

  const folders = Array.isArray(inventory.folders) ? inventory.folders : [];
  const desiredName = normalizeName(folderName);
  const desiredId = toText(folderId);

  if (desiredId) {
    const exactId = folders.find((folder) => toText(folder.folderId) === desiredId);
    if (exactId) {
      return exactId;
    }
  }

  if (desiredName) {
    const exactName = folders.find((folder) => normalizeName(folder.folderName) === desiredName);
    if (exactName) {
      return exactName;
    }
  }

  return null;
}

function verifyCustomValueFolderAssociation(inventoryOrItems, folderName, folderId = "") {
  const inventory = Array.isArray(inventoryOrItems)
    ? buildCustomValueInventory(inventoryOrItems)
    : inventoryOrItems && typeof inventoryOrItems === "object"
      ? inventoryOrItems
      : { items: [], folders: [] };

  const targetFolder = findCustomValueFolder(inventory, folderName, folderId);
  if (!folderName) {
    return { verified: true, folder: null, failures: [] };
  }

  if (!targetFolder) {
    return {
      verified: false,
      folder: null,
      failures: [`Folder "${folderName}" was not found in the returned inventory.`],
    };
  }

  const targetName = normalizeName(targetFolder.folderName || folderName);
  const targetId = toText(targetFolder.folderId || folderId);
  const failures = [];

  for (const item of Array.isArray(inventory.items) ? inventory.items : []) {
    if (normalizeName(item.folderName || "") !== targetName) {
      continue;
    }

    if (targetId && toText(item.folderId || "") && toText(item.folderId || "") !== targetId) {
      failures.push(`Folder ID mismatch for "${item.name}".`);
    }
  }

  return {
    verified: failures.length === 0,
    folder: targetFolder,
    failures,
  };
}

module.exports = {
  buildCustomValueInventory,
  canonicalHeaderKey,
  classifyCustomValueRows,
  findCustomValueFolder,
  extractCustomValueItems,
  normalizeExistingCustomValue,
  normalizeImportRow,
  normalizeName,
  normalizeHeader,
  parseCsvText,
  parseDelimitedText,
  parseWorkbookBuffer,
  verifyCustomValueFolderAssociation,
  toText,
};
