const $ = (id) => document.getElementById(id);

const state = {
  connection: null,
  loading: {
    connect: false,
    inventory: false,
    preview: false,
    import: false,
    disconnect: false,
  },
  pagination: {
    inventory: { page: 1, pageSize: 10 },
    preview: { page: 1, pageSize: 10 },
    results: { page: 1, pageSize: 10 },
  },
  resultRows: [],
  customValuesImport: {
    file: null,
    preview: null,
  },
  customValuesInventory: {
    items: [],
    folders: [],
    loaded: false,
    verified: false,
    error: "",
    selectedFolderKey: "",
  },
};

const els = {
  form: $("connection-form"),
  token: $("integration-token"),
  locationId: $("connection-location-id"),
  test: $("test-button"),
  toggle: $("toggle-token"),
  message: $("connection-result"),
  account: $("account-card"),
  accountName: $("account-name"),
  accountLocation: $("account-location"),
  accountInline: $("account-name-inline"),
  selectedLocationInline: $("selected-location-inline"),
  selectedLocationIdInline: $("selected-location-id-inline"),
  locations: $("connection-locations"),
  refreshLocations: $("refresh-locations"),
  changeLocation: $("change-location"),
  disconnect: $("disconnect-button"),
  refreshInventory: $("refresh-inventory"),
  customForm: $("custom-values-form"),
  customFolder: $("custom-value-folder-name"),
  customRows: $("custom-value-rows"),
  customAdd: $("custom-value-add"),
  customImportFile: $("custom-value-import-file"),
  customPreview: $("custom-value-preview"),
  customConfirm: $("custom-value-confirm"),
  customSubmit: $("custom-values-submit"),
  customInventory: $("custom-values-inventory"),
  customResult: $("custom-values-result"),
  customPreviewWrap: $("custom-values-preview"),
  topStatus: $("top-status"),
  dashboardCustomValues: $("dashboard-custom-values"),
  dashboardFolders: $("dashboard-folders"),
  dashboardLastImport: $("dashboard-last-import"),
  dashboardConnection: $("dashboard-connection"),
  customFileName: $("custom-file-name"),
  mobileNavToggle: $("mobile-nav-toggle"),
  sidebar: $("app-sidebar"),
};

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

function pageSlice(items, key) {
  const values = Array.isArray(items) ? items : [];
  const pagination = state.pagination[key];
  const totalPages = Math.max(1, Math.ceil(values.length / pagination.pageSize));
  pagination.page = Math.min(Math.max(1, pagination.page), totalPages);
  const start = (pagination.page - 1) * pagination.pageSize;
  return {
    items: values.slice(start, start + pagination.pageSize),
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalPages,
    start,
    end: Math.min(start + pagination.pageSize, values.length),
    total: values.length,
  };
}

function paginationMarkup(key, total, label = "rows") {
  const pagination = state.pagination[key];
  const totalPages = Math.max(1, Math.ceil(total / pagination.pageSize));
  pagination.page = Math.min(Math.max(1, pagination.page), totalPages);
  const start = total ? (pagination.page - 1) * pagination.pageSize : 0;
  const end = Math.min(start + pagination.pageSize, total);
  if (totalPages <= 1) {
    return "";
  }

  return `
    <div class="pagination" data-pagination="${esc(key)}">
      <span>Showing ${total ? start + 1 : 0}–${end} of ${total} ${esc(label)}</span>
      <label>Rows per page
        <select data-page-size="${esc(key)}">
          ${PAGE_SIZE_OPTIONS.map((size) => `<option value="${size}" ${size === pagination.pageSize ? "selected" : ""}>${size}</option>`).join("")}
        </select>
      </label>
      <button type="button" class="ghost" data-page-action="prev" data-page-key="${esc(key)}" ${pagination.page <= 1 ? "disabled" : ""}>Previous</button>
      <span>Page ${pagination.page} of ${totalPages}</span>
      <button type="button" class="ghost" data-page-action="next" data-page-key="${esc(key)}" ${pagination.page >= totalPages ? "disabled" : ""}>Next</button>
    </div>
  `;
}

function bindPagination(container, key, render) {
  container.querySelectorAll("[data-page-action]").forEach((button) => {
    button.onclick = () => {
      const nextPage = state.pagination[key].page + (button.dataset.pageAction === "next" ? 1 : -1);
      state.pagination[key].page = Math.max(1, nextPage);
      render();
    };
  });
  const size = container.querySelector(`[data-page-size="${key}"]`);
  if (size) {
    size.onchange = () => {
      state.pagination[key].pageSize = Number(size.value) || 10;
      state.pagination[key].page = 1;
      render();
    };
  }
}

function setButtonLoading(button, loading, loadingText) {
  if (!button) {
    return;
  }
  if (loading) {
    button.dataset.defaultLabel = button.textContent.trim();
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(loadingText)}`;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  } else {
    button.textContent = button.dataset.defaultLabel || button.textContent;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function showInlineLoading(element, text) {
  if (!element) {
    return;
  }
  element.className = "message loading-message";
  element.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(text)}`;
  element.classList.remove("hidden");
}

function clearCustomValuesResult() {
  state.resultRows = [];
  state.pagination.results.page = 1;
  els.customResult.className = "message hidden";
  els.customResult.innerHTML = "";
}

function resetFileImportState() {
  state.customValuesImport.file = null;
  state.customValuesImport.preview = null;
  state.pagination.preview.page = 1;
  state.pagination.results.page = 1;
  clearCustomValuesResult();
  renderCustomValuesPreview(null);
  if (els.customFileName) {
    els.customFileName.textContent = "No file selected";
  }
}

function msg(text, type = "") {
  els.message.className = `message ${type}`;
  els.message.textContent = text;
  els.message.classList.remove("hidden");
}

function looksLikeLocationId(value) {
  const trimmed = String(value || "").trim();
  return Boolean(trimmed) && /^[A-Za-z0-9]{18,28}$/.test(trimmed) && !trimmed.includes(".") && !trimmed.includes(" ");
}

function looksLikePrivateIntegrationToken(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed.includes(" ")) {
    return false;
  }

  return trimmed.toLowerCase().startsWith("pit-") && trimmed.length > 8;
}

function formatConnectionError(data) {
  const code = String(data?.code || "").trim();
  const fallback = String(data?.details || data?.message || "Connection failed.").trim();
  const map = {
    INVALID_TOKEN: "Invalid Private Integration Token.",
    INVALID_LOCATION_ID: "Invalid Location ID.",
    INVALID_LOCATION: "Unable to verify this GHL location.",
    TOKEN_FORBIDDEN_FOR_LOCATION: "Token does not have access to this Location ID.",
    LOCATION_NOT_FOUND: "Unable to verify this GHL location.",
    LOCATION_NOT_AUTHORIZED: "Unable to verify this GHL location.",
    TOKEN_VALID_BUT_FORBIDDEN: "The token is valid, but it cannot list agency locations.",
    NO_ACCESSIBLE_LOCATIONS: "The token is valid, but it cannot list agency locations.",
    MISSING_SCOPE: "The token is missing a required scope for this request.",
    GHL_RATE_LIMIT: "GHL rate limit reached. Please retry in a moment.",
    NETWORK_ERROR: "Could not reach GHL. Check your connection and try again.",
    GHL_API_ERROR: "GHL API error while verifying the connection.",
    UNKNOWN_AUTH_ERROR: "GHL connection failed. Please try again.",
  };

  return map[code] || fallback;
}

function currentConnection() {
  return state.connection || null;
}

function selectedLocationId() {
  return String(state.connection?.selectedLocationId || state.connection?.locationId || "").trim();
}

function syncConnectionUI() {
  const connection = currentConnection();
  const selected = connection?.selectedLocation || null;
  const connected = Boolean(connection);
  const ready = Boolean(connection && selectedLocationId());
  const displayLocationId = selected?.id || connection?.selectedLocationId || (connected ? "Select a location" : "-");

  els.account.classList.toggle("hidden", !connected);
  els.accountName.textContent = connection?.accountName || connection?.companyName || "Not connected";
  els.accountLocation.textContent = displayLocationId;
  els.accountInline.textContent = connection?.accountName || connection?.companyName || "Not connected";
  els.selectedLocationInline.textContent = selected?.name || connection?.selectedLocationName || "None";
  els.selectedLocationIdInline.textContent = selected?.id || connection?.selectedLocationId || (connected ? "Select a location" : "-");
  els.topStatus.innerHTML = `<span class="status-dot"></span>${ready ? "Connected" : connected ? "Location needed" : "Not connected"}`;
  els.topStatus.classList.toggle("is-connected", ready);
  if (els.dashboardConnection) {
    els.dashboardConnection.textContent = ready ? "Connected" : connected ? "Needs location" : "Not connected";
  }
  els.test.disabled = state.loading.connect;
  els.refreshLocations.disabled = !connected;
  els.changeLocation.disabled = !connected;
  els.disconnect.disabled = !connected || state.loading.disconnect;
  els.refreshInventory.disabled = !ready || state.loading.inventory;
  els.customPreview.disabled = !ready || state.loading.preview;
  els.customConfirm.disabled = !ready || !state.customValuesImport.preview || state.loading.import;
  els.customSubmit.disabled = !ready || state.loading.import;
  els.customAdd.disabled = !ready || state.loading.import;
  els.customImportFile.disabled = !ready || state.loading.import;
  els.customFolder.disabled = !ready || state.loading.import;
}

function renderConnectionLocations(locations = []) {
  const selectedId = selectedLocationId();
  const hasLocations = Array.isArray(locations) && locations.length > 0;

  els.locations.innerHTML = `
    <div class="connection-locations-head">
      <strong>${hasLocations ? "Available Locations" : "Manual Location Required"}</strong>
      <span>${hasLocations ? `${locations.length} discovered` : "Token accepted; enter a location id to continue."}</span>
    </div>
    ${
      hasLocations
        ? `<div class="connection-location-list">
            ${locations
              .map(
                (location) => `
                  <button type="button" class="connection-location ${String(location.id || "") === selectedId ? "selected" : ""}" data-location-id="${esc(location.id || "")}">
                    <span>${esc(location.name || "")}</span>
                    <code>${esc(location.id || "")}</code>
                  </button>
                `
              )
              .join("")}
          </div>`
        : `<div class="connection-location-note">
            Token accepted, but this integration cannot list agency locations. Enter/select the sub-account location you want to use.
          </div>
          <div class="manual-location-row">
            <input type="text" class="manual-location-input" data-manual-location-id placeholder="Location ID">
            <button type="button" class="primary manual-location-submit">Use location</button>
          </div>`
    }
  `;
  els.locations.classList.remove("hidden");
  els.locations.querySelectorAll("[data-location-id]").forEach((button) => {
    button.onclick = () => selectLocation(button.dataset.locationId);
  });
  const manualSubmit = els.locations.querySelector(".manual-location-submit");
  if (manualSubmit) {
    manualSubmit.onclick = () => {
      const manualInput = els.locations.querySelector("[data-manual-location-id]");
      selectLocation(manualInput?.value || "");
    };
  }
}

function renderCustomValuesResult({
  created = 0,
  updated = 0,
  unchanged = 0,
  failed = 0,
  folderAssociationVerified = false,
  note = "",
  title = "Custom Values",
  tone = "success",
  rows = null,
} = {}) {
  if (Array.isArray(rows)) {
    state.resultRows = rows;
    state.pagination.results.page = 1;
  }
  const resultPage = pageSlice(state.resultRows, "results");
  els.customResult.className = `message ${tone === "warning" ? "warning" : "success"}`;
  els.customResult.innerHTML = `
    <div class="custom-values-summary">
      <strong>${esc(title)}</strong>
      <span>Created: ${esc(created)}</span>
      <span>Updated: ${esc(updated)}</span>
      <span>Unchanged: ${esc(unchanged)}</span>
      <span>Failed: ${esc(failed)}</span>
      <span>Folder Association Verified: ${folderAssociationVerified ? "Yes" : "No"}</span>
      ${note ? `<small>${esc(note)}</small>` : ""}
    </div>
    ${
      state.resultRows.length
        ? `<div class="custom-values-result-list">
            ${resultPage.items.map((row) => `<div class="custom-values-result-row">${esc(row)}</div>`).join("")}
          </div>
          ${paginationMarkup("results", state.resultRows.length, "results")}`
        : ""
    }
  `;
  els.customResult.classList.remove("hidden");
  bindPagination(els.customResult, "results", () => renderCustomValuesResult({
    created,
    updated,
    unchanged,
    failed,
    folderAssociationVerified,
    note,
    title,
    tone,
  }));
}

function renderCustomValuesError(text) {
  state.resultRows = [];
  els.customResult.className = "message error";
  els.customResult.textContent = text;
  els.customResult.classList.remove("hidden");
}

function hasImportSummary(data) {
  return ["created", "updated", "unchanged", "failed"].some((key) => Number(data?.[key] || 0) > 0)
    || (Array.isArray(data?.verificationFailures) && data.verificationFailures.length > 0);
}

function inventoryFolderKey(value) {
  const folderId = String(value?.folderId || "").trim();
  if (folderId) {
    return `id:${folderId}`;
  }
  const folderName = String(value?.folderName || "").trim().toLowerCase().replace(/\s+/g, " ");
  return folderName ? `name:${folderName}` : "";
}

function inventoryFolderLabel(folder) {
  return String(folder?.folderName || "").trim() || "Folder name unavailable";
}

function renderCustomValuesInventoryPanel() {
  const inventory = state.customValuesInventory || {};
  const items = Array.isArray(inventory.items) ? inventory.items : [];
  const folders = Array.isArray(inventory.folders) ? inventory.folders : [];
  const folderCatalogAvailable = inventory.folderCatalogAvailable === true;
  const selectedFolderKey = inventory.selectedFolderKey || "";
  const counts = new Map();
  const folderIds = new Set(folders.filter((folder) => folder.source === "folder-catalog").map((folder) => String(folder.folderId || "").trim()).filter(Boolean));
  const folderNames = new Map();
  for (const item of items) {
    const key = inventoryFolderKey(item);
    if (key) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  for (const folder of folders) {
    const name = String(folder.folderName || "").trim().toLowerCase();
    if (name) {
      const ids = folderNames.get(name) || new Set();
      ids.add(String(folder.folderId || "").trim() || `name:${name}`);
      folderNames.set(name, ids);
    }
  }
  const duplicateFolderNames = [...folderNames.values()].filter((ids) => ids.size > 1).length;
  const unassignedItems = items.filter((item) => !inventoryFolderKey(item));
  const orphanItems = items.filter((item) => item.folderId && !folderIds.has(String(item.folderId).trim()));
  const foldersWithValues = folders.filter((folder) => (counts.get(inventoryFolderKey(folder)) || 0) > 0).length;
  const emptyFolders = folderCatalogAvailable ? folders.filter((folder) => (counts.get(inventoryFolderKey(folder)) || 0) === 0).length : 0;
  const folderSummary = folders
    .map((folder) => {
      const key = inventoryFolderKey(folder);
      const count = counts.get(key) || 0;
      const warning = duplicateFolderNames && folder.folderName && [...folderNames.get(String(folder.folderName).trim().toLowerCase())].length > 1;
      return `<button type="button" class="chip folder-chip ${selectedFolderKey === key ? "selected" : ""}" data-folder-key="${esc(key)}"><span>${esc(inventoryFolderLabel(folder))}</span><strong>${count}</strong><small>values</small>${warning ? `<em>Duplicate name</em>` : ""}${folder.folderId && !folder.folderName ? `<code>${esc(folder.folderId)}</code>` : ""}</button>`;
    })
    .join("");
  const visibleItems = selectedFolderKey === "__unassigned__"
    ? unassignedItems
    : selectedFolderKey
      ? items.filter((item) => inventoryFolderKey(item) === selectedFolderKey)
      : items;

  if (!els.customInventory) {
    return;
  }

  if (els.dashboardCustomValues) {
    els.dashboardCustomValues.textContent = inventory.loaded ? String(items.length) : "-";
  }
  if (els.dashboardFolders) {
    els.dashboardFolders.textContent = inventory.loaded ? (folderCatalogAvailable ? String(folders.length) : "Unknown") : "-";
  }

  if (inventory.error) {
    els.customInventory.innerHTML = `<div class="empty">${esc(inventory.error)}</div>`;
    els.customInventory.classList.remove("hidden");
    return;
  }

  const visiblePage = pageSlice(visibleItems, "inventory");

  els.customInventory.innerHTML = `
    <div class="custom-values-inventory-summary">
      <span>${esc(items.length)} values</span>
      <span>${esc(folderCatalogAvailable ? folders.length : "Folder catalog unavailable")}</span>
      <span>${esc(foldersWithValues)} with values</span>
      <span>${esc(emptyFolders)} empty</span>
      <span>${esc(unassignedItems.length)} unassigned</span>
      ${orphanItems.length ? `<span class="inventory-warning">${esc(orphanItems.length)} orphan folder ID</span>` : ""}
      ${duplicateFolderNames ? `<span class="inventory-warning">${esc(duplicateFolderNames)} duplicate folder name</span>` : ""}
      ${!folderCatalogAvailable ? `<span class="inventory-warning">Folder names unavailable from API</span>` : ""}
      <span>${inventory.verified ? "Verified readback" : "Unverified"}</span>
    </div>
    <div class="custom-values-folder-chips"><button type="button" class="chip folder-chip ${!selectedFolderKey ? "selected" : ""}" data-folder-key="">All values <strong>${items.length}</strong></button>${folderSummary}<button type="button" class="chip folder-chip ${selectedFolderKey === "__unassigned__" ? "selected" : ""}" data-folder-key="__unassigned__">Unassigned <strong>${unassignedItems.length}</strong></button></div>
    <div class="table-head custom-values-head">
      <span>Name</span><span>Value</span><span>Folder</span><span>Status</span><span>ID</span>
    </div>
    ${
      visibleItems.length
        ? visiblePage.items
            .map(
              (item) => {
                const associated = Boolean(inventoryFolderKey(item));
                const folderText = item.folderName || (item.folderId ? `Folder ID ${item.folderId}` : "Unassigned");
                return `
                <div class="table-row custom-values-row">
                  <span class="item-name">${esc(item.name || "")}</span>
                  <span>${esc(item.value || "")}</span>
                  <span>${esc(folderText)}</span>
                  <span class="badge ${associated ? "ready" : "incomplete"}">${associated ? "Foldered" : "Unassigned"}</span>
                  <span><code>${esc(item.folderId || item.id || "")}</code></span>
                </div>
              `;
              }
            )
            .join("")
        : '<div class="empty">No custom values were returned for this location.</div>'
    }
    ${paginationMarkup("inventory", visibleItems.length, selectedFolderKey ? "filtered values" : "Custom Values")}
  `;
  els.customInventory.classList.remove("hidden");
  els.customInventory.querySelectorAll("[data-folder-key]").forEach((button) => {
    button.onclick = () => {
      state.customValuesInventory.selectedFolderKey = button.dataset.folderKey || "";
      state.pagination.inventory.page = 1;
      renderCustomValuesInventoryPanel();
    };
  });
  bindPagination(els.customInventory, "inventory", renderCustomValuesInventoryPanel);
}

async function refreshCustomValuesInventory() {
  const connection = currentConnection();
  if (!connection || !selectedLocationId()) {
    return;
  }

  if (state.loading.inventory) {
    return;
  }

  state.loading.inventory = true;
  setButtonLoading(els.refreshInventory, true, "Loading Custom Values…");
  syncConnectionUI();
  try {
    const response = await fetch("/api/custom-values/inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.details || data.message || "Custom values inventory failed");
    }

    state.customValuesInventory = {
      items: Array.isArray(data.items) ? data.items : [],
      folders: Array.isArray(data.folders) ? data.folders : [],
      folderCatalogAvailable: data.folderCatalogAvailable === true,
      loaded: true,
      verified: Boolean(data.verified),
      error: "",
      selectedFolderKey: "",
    };
    state.pagination.inventory.page = 1;
  } catch (error) {
    state.customValuesInventory = {
      items: [],
      folders: [],
      folderCatalogAvailable: false,
      loaded: false,
      verified: false,
      error: error.message,
    };
  } finally {
    state.loading.inventory = false;
    setButtonLoading(els.refreshInventory, false);
    syncConnectionUI();
  }

  renderCustomValuesInventoryPanel();
}

function customValueRows() {
  return [...els.customRows.querySelectorAll(".custom-value-row")];
}

function addCustomValueRow(data = {}) {
  const row = document.createElement("div");
  row.className = "custom-value-row";
  row.innerHTML = `
    <div class="field">
      <label>Name</label>
      <input type="text" class="custom-value-name" autocomplete="off" placeholder="Value name" value="${esc(data.name || "")}">
    </div>
    <div class="field">
      <label>Value</label>
      <input type="text" class="custom-value-value" autocomplete="off" placeholder="Value" value="${esc(data.value || "")}">
    </div>
    <button type="button" class="ghost custom-value-remove">Remove</button>
  `;

  row.querySelector(".custom-value-remove").onclick = () => {
    row.remove();
    if (!customValueRows().length) {
      addCustomValueRow();
    }
  };

  els.customRows.appendChild(row);
  return row;
}

function readCustomValues() {
  const rows = customValueRows().map((row) => {
    const name = row.querySelector(".custom-value-name").value.trim();
    const value = row.querySelector(".custom-value-value").value.trim();
    return { name, value };
  });

  const hasPartialRow = rows.some((row) => (row.name || row.value) && (!row.name || !row.value));
  const values = rows.filter((row) => row.name && row.value);

  return { rows, values, hasPartialRow };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function readFilePayload(file) {
  if (!file) {
    return null;
  }

  const text = await file.text();
  const base64 = file.type.includes("sheet") || /\.xlsx?$/i.test(file.name)
    ? arrayBufferToBase64(await file.arrayBuffer())
    : "";

  return {
    fileName: file.name,
    fileType: file.type,
    fileText: text,
    fileBase64: base64,
  };
}

function renderCustomValuesPreview(previewResult) {
  state.customValuesImport.preview = previewResult;

  if (!previewResult) {
    els.customPreviewWrap.classList.add("hidden");
    els.customPreviewWrap.innerHTML = "";
    els.customConfirm.disabled = true;
    return;
  }

  const rows = Array.isArray(previewResult.preview) ? previewResult.preview : [];
  const page = pageSlice(rows, "preview");
  const counts = previewResult.counts || {};
  const summary = `
    <div class="custom-values-summary">
      <strong>Import Preview</strong>
      <span>Create: ${esc(counts.create || 0)}</span>
      <span>Update: ${esc(counts.update || 0)}</span>
      <span>Unchanged: ${esc(counts.unchanged || 0)}</span>
      <span>Conflict: ${esc(counts.conflict || 0)}</span>
      <span>Invalid: ${esc(counts.invalid || 0)}</span>
    </div>
  `;

  els.customPreviewWrap.innerHTML = `
    ${summary}
    <div class="custom-values-preview-table">
      <div class="table-head custom-values-preview-head">
        <span>Action</span>
        <span>Name</span>
        <span>Existing Value</span>
        <span>Imported Value</span>
        <span>Existing Folder</span>
        <span>Target Folder</span>
        <span>Folder Status</span>
      </div>
      ${
        rows.length
          ? page.items
              .map(
                (row) => `
                  <div class="table-row custom-values-preview-row ${esc(row.action || "")}">
                    <span class="badge ${esc(String(row.action || "").toLowerCase())}">${esc(row.action || "")}</span>
                    <span>${esc(row.name || "")}</span>
                    <span>${esc(row.existingValue || "")}</span>
                    <span>${esc(row.importedValue || "")}</span>
                    <span>${esc(row.existingFolder || "")}</span>
                    <span>${esc(row.targetFolder || "")}</span>
                    <span class="badge ${esc(String(row.folderStatus || "").toLowerCase())}">${esc(row.folderStatus || "")}</span>
                  </div>
                `
              )
              .join("")
          : '<div class="empty">No rows to preview.</div>'
      }
    </div>
    ${paginationMarkup("preview", rows.length, "preview rows")}
  `;
  els.customPreviewWrap.classList.remove("hidden");
  els.customConfirm.disabled = !(previewResult && rows.length);
  bindPagination(els.customPreviewWrap, "preview", () => renderCustomValuesPreview(state.customValuesImport.preview));
}

async function previewCustomValuesImport() {
  const connection = currentConnection();
  const locationId = selectedLocationId();
  const folderName = els.customFolder.value.trim();
  const file = els.customImportFile.files?.[0] || null;
  const fileMode = Boolean(file);

  if (!connection || !locationId) {
    renderCustomValuesError("Connect the account before previewing Custom Value imports.");
    return;
  }

  if (!file) {
    renderCustomValuesError("Choose a CSV or XLSX file to preview.");
    return;
  }

  if (state.loading.preview) {
    return;
  }
  state.loading.preview = true;
  setButtonLoading(els.customPreview, true, "Reading file and comparing…");
  showInlineLoading(els.customResult, "Reading file and comparing…");
  syncConnectionUI();

  try {
    const payload = await readFilePayload(file);
    const response = await fetch("/api/custom-values/import-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        targetFolderName: fileMode ? "" : folderName,
      }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.details || data.message || "Custom values preview failed");
    }

    state.customValuesImport.file = payload;
    state.customValuesImport.preview = data;
    state.pagination.preview.page = 1;
    if (els.customFileName) {
      els.customFileName.textContent = `${file.name} - ${Array.isArray(data.preview) ? data.preview.length : 0} rows`;
    }
    if (els.dashboardLastImport) {
      els.dashboardLastImport.textContent = "Preview ready";
    }
    renderCustomValuesPreview(data);
    renderCustomValuesResult({
      title: "Import Preview",
      created: data.counts?.create || 0,
      updated: data.counts?.update || 0,
      unchanged: data.counts?.unchanged || 0,
      failed: (data.counts?.conflict || 0) + (data.counts?.invalid || 0),
      folderAssociationVerified: false,
      note: fileMode ? "Preview ready. File rows are authoritative." : "Preview ready.",
    });
  } catch (error) {
    renderCustomValuesError(error.message);
  } finally {
    state.loading.preview = false;
    setButtonLoading(els.customPreview, false);
    syncConnectionUI();
  }
}

async function confirmCustomValuesImport() {
  const connection = currentConnection();
  const locationId = selectedLocationId();
  const folderName = els.customFolder.value.trim();
  const file = state.customValuesImport.file || null;
  const preview = state.customValuesImport.preview || null;
  const fileMode = Boolean(file);

  if (!connection || !locationId) {
    renderCustomValuesError("Connect the account before importing Custom Values.");
    return;
  }

  if (!file || !preview) {
    renderCustomValuesError("Preview the import before confirming it.");
    return;
  }

  if (state.loading.import) {
    return;
  }
  state.loading.import = true;
  setButtonLoading(els.customConfirm, true, "Creating and updating Custom Values…");
  showInlineLoading(els.customResult, "Creating and updating Custom Values…");
  syncConnectionUI();

  try {
    const response = await fetch("/api/custom-values/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...file,
        targetFolderName: fileMode ? "" : folderName,
        mode: "execute",
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.details || data.message || "Custom values import failed");
    }

    if (!data.success && !hasImportSummary(data)) {
      throw new Error(data.details || data.message || "Custom values import failed");
    }

    const created = Number(data.created || 0);
    const updated = Number(data.updated || 0);
    const unchanged = Number(data.unchanged || 0);
    const failed = Number(data.failed || 0);
    const partial = failed > 0 || data.success === false;

    showInlineLoading(els.customResult, "Verifying changes…");
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (els.dashboardLastImport) {
      els.dashboardLastImport.textContent = "Complete";
    }
    renderCustomValuesResult({
      title: partial ? "Import completed with issues" : "Import Complete",
      tone: partial ? "warning" : "success",
      created,
      updated,
      unchanged,
      failed,
      folderAssociationVerified: Boolean(data.folderAssociationVerified),
      note: data.error || (partial ? "Some rows need attention." : ""),
      rows: Array.isArray(data.verificationFailures) ? data.verificationFailures : [],
    });
    if (els.dashboardLastImport) {
      els.dashboardLastImport.textContent = "Complete";
    }
    state.customValuesImport.file = null;
    state.customValuesImport.preview = null;
    els.customImportFile.value = "";
    renderCustomValuesPreview(null);
    await refreshCustomValuesInventory();
  } catch (error) {
    renderCustomValuesError(error.message);
  } finally {
    state.loading.import = false;
    setButtonLoading(els.customConfirm, false);
    syncConnectionUI();
  }
}

async function submitCustomValues(event) {
  event.preventDefault();

  if (state.loading.import) {
    return;
  }

  const connection = currentConnection();
  const locationId = selectedLocationId();
  const folderName = els.customFolder.value.trim();
  const file = els.customImportFile.files?.[0] || state.customValuesImport.file || null;
  const { values, hasPartialRow } = readCustomValues();

  if (file) {
    renderCustomValuesError("Use Preview import and Confirm import for CSV/XLSX uploads.");
    return;
  }

  if (!connection || !locationId) {
    renderCustomValuesError("Connect the account before setting up Custom Values.");
    return;
  }

  if (hasPartialRow) {
    renderCustomValuesError("Each Custom Value row must include both a Name and a Value.");
    return;
  }

  if (!folderName && values.length) {
    renderCustomValuesError("Folder Name is required when Custom Values are provided.");
    return;
  }

  if (!folderName && !values.length) {
    renderCustomValuesResult({
      title: "Custom Values",
      created: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      folderAssociationVerified: false,
      note: "No Custom Values were provided.",
    });
    return;
  }

  if (folderName && !values.length) {
    renderCustomValuesResult({
      title: "Custom Values",
      created: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      folderAssociationVerified: false,
      note: "No Custom Values were provided.",
    });
    return;
  }

  const customControls = [els.customSubmit, els.customAdd].filter(Boolean);
  state.loading.import = true;
  setButtonLoading(els.customSubmit, true, "Creating and updating Custom Values…");
  customControls.forEach((control) => {
    control.disabled = true;
  });
  syncConnectionUI();

  try {
    const response = await fetch("/api/custom-values/ensure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customValueFolderName: folderName,
        customValues: values,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.details || data.message || "Custom Values setup failed");
    }

    if (!data.success && !hasImportSummary(data)) {
      throw new Error(data.details || data.message || "Custom Values setup failed");
    }

    const created = Number(data.created || 0);
    const updated = Number(data.updated || 0);
    const existing = Number(data.unchanged || data.skipped || 0);
    const failed = Number(data.failed || 0) + (data.folderStatus === "failed" ? 1 : 0);
    const partial = failed > 0 || data.success === false;

    renderCustomValuesResult({
      title: partial ? "Custom Values Applied with issues" : "Custom Values Applied",
      tone: partial ? "warning" : "success",
      created,
      updated,
      unchanged: existing,
      failed,
      folderAssociationVerified: Boolean(data.folderAssociationVerified && data.folderStatus !== "failed"),
      note: data.message || (partial ? "Some rows need attention." : ""),
    });
    if (els.dashboardLastImport) {
      els.dashboardLastImport.textContent = "Complete";
    }
    await refreshCustomValuesInventory();
  } catch (error) {
    renderCustomValuesError(error.message);
  } finally {
    state.loading.import = false;
    setButtonLoading(els.customSubmit, false);
    customControls.forEach((control) => {
      control.disabled = false;
    });
    syncConnectionUI();
  }
}

function applyConnection(connection, options = {}) {
  state.connection = connection || null;
  if (connection) {
    els.account.classList.remove("hidden");
    els.accountName.textContent = connection.accountName || connection.companyName || "Connected GHL Account";
    els.accountLocation.textContent = connection.selectedLocationId || "-";
    els.locationId.value = connection.selectedLocationId || connection.locationId || "";
    renderConnectionLocations(connection.locations || []);
  } else {
    els.locations.classList.add("hidden");
    els.locations.innerHTML = "";
    els.account.classList.add("hidden");
    els.accountName.textContent = "-";
    els.accountLocation.textContent = "-";
    els.accountInline.textContent = "Not connected";
    els.selectedLocationInline.textContent = "None";
    els.selectedLocationIdInline.textContent = "-";
    els.token.value = "";
    els.token.type = "password";
    els.toggle.textContent = "Show";
    els.locationId.value = "";
    resetFileImportState();
    state.pagination.inventory.page = 1;
    state.customValuesInventory = {
      items: [],
      folders: [],
      folderCatalogAvailable: false,
      loaded: false,
      verified: false,
      error: "",
    };
    renderCustomValuesInventoryPanel();
  }

  if (!options.silent) {
    syncConnectionUI();
  } else {
    syncConnectionUI();
  }
}

async function loadConnection() {
  try {
    const response = await fetch("/api/connection/status", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    const data = await response.json();
    if (response.ok && data.success && data.connected && data.connection) {
      applyConnection(data.connection, { silent: true });
      if (selectedLocationId()) {
        await refreshCustomValuesInventory();
      }
    } else {
      applyConnection(null, { silent: true });
    }
  } catch {
    applyConnection(null, { silent: true });
  }
  syncConnectionUI();
}

async function refreshLocations() {
  const connection = currentConnection();
  if (!connection) {
    return;
  }

  try {
    const response = await fetch("/api/connection/locations", { method: "GET" });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(formatConnectionError(data));
    }
    applyConnection({ ...connection, locations: data.locations || [] }, { silent: true });
    syncConnectionUI();
  } catch (error) {
    msg(error.message, "error");
  }
}

async function selectLocation(locationId) {
  const connection = currentConnection();
  if (!connection || !locationId) {
    return;
  }

  try {
    const response = await fetch("/api/connection/select-location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locationId }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(formatConnectionError(data));
    }

    const nextConnection = data.connection || connection;
    applyConnection(nextConnection, { silent: true });
    msg(`Connected location: ${data.selectedLocation?.name || locationId}`, "success");
    await refreshCustomValuesInventory();
    syncConnectionUI();
  } catch (error) {
    msg(error.message, "error");
  }
}

async function disconnectConnection() {
  if (state.loading.disconnect) {
    return;
  }

  state.loading.disconnect = true;
  setButtonLoading(els.disconnect, true, "Disconnecting…");
  syncConnectionUI();

  try {
    const response = await fetch("/api/connection/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.details || data.message || "Disconnect failed");
    }
    applyConnection(null, { silent: true });
    msg("Disconnected.", "success");
    syncConnectionUI();
  } catch (error) {
    msg(error.message, "error");
  } finally {
    state.loading.disconnect = false;
    setButtonLoading(els.disconnect, false);
    syncConnectionUI();
  }
}

async function handleConnectionConnect(event) {
  event.preventDefault();
  if (state.loading.connect) {
    return;
  }
  const token = els.token.value.trim();
  const locationId = els.locationId.value.trim();

  if (looksLikeLocationId(token)) {
    msg("This looks like a Location ID, not an Integration Token.", "error");
    return;
  }
  if (!looksLikePrivateIntegrationToken(token)) {
    msg("That GHL token is invalid. Paste a valid Private Integration Token.", "error");
    return;
  }
  if (!locationId) {
    msg("GHL Location ID is required.", "error");
    return;
  }
  if (looksLikePrivateIntegrationToken(locationId)) {
    msg("This looks like a token, not a Location ID.", "error");
    return;
  }

  state.loading.connect = true;
  setButtonLoading(els.test, true, "Connecting…");
  syncConnectionUI();
  msg("Connecting…");

  try {
    const response = await fetch("/api/connection/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, locationId, mode: "manual-token-location" }),
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(formatConnectionError(data));
    }

    applyConnection(data.connection || {
      accountName: data.accountName || data.companyName || "Connected GHL Account",
      companyName: data.companyName || "",
      locations: data.locations || [],
      selectedLocationId: data.selectedLocation?.id || locationId,
      selectedLocation: data.selectedLocation || { id: locationId, name: "Selected GHL Location" },
    }, { silent: true });
    renderConnectionLocations(data.locations || []);
    els.accountName.textContent = data.accountName || data.companyName || "Connected GHL Account";
    els.accountLocation.textContent = data.connection?.selectedLocationId || data.selectedLocation?.id || locationId;
    els.account.classList.remove("hidden");
    els.topStatus.innerHTML = '<span class="status-dot"></span>Connected';
    els.token.value = "";
    els.token.type = "password";
    els.toggle.textContent = "Show";
    msg("Connection successful.", "success");
    await refreshCustomValuesInventory();
    syncConnectionUI();
  } catch (error) {
    msg(error.message, "error");
  } finally {
    state.loading.connect = false;
    setButtonLoading(els.test, false);
    syncConnectionUI();
  }
}

function initCustomValuesSection() {
  addCustomValueRow();
  els.customAdd.onclick = () => addCustomValueRow();
  els.customPreview.onclick = () => previewCustomValuesImport();
  els.customConfirm.onclick = () => confirmCustomValuesImport();
  els.customImportFile.onchange = () => {
    resetFileImportState();
    const file = els.customImportFile.files?.[0] || null;
    if (file && els.customFileName) {
      els.customFileName.textContent = file.name;
    }
  };
  els.customForm.onsubmit = submitCustomValues;
}

els.toggle.onclick = () => {
  const hidden = els.token.type === "password";
  els.token.type = hidden ? "text" : "password";
  els.toggle.textContent = hidden ? "Hide" : "Show";
};

els.form.onsubmit = handleConnectionConnect;
els.refreshLocations.onclick = refreshLocations;
els.changeLocation.onclick = refreshLocations;
els.disconnect.onclick = disconnectConnection;
els.refreshInventory.onclick = () => refreshCustomValuesInventory();

if (els.mobileNavToggle && els.sidebar) {
  els.mobileNavToggle.onclick = () => {
    const open = els.sidebar.classList.toggle("open");
    els.mobileNavToggle.setAttribute("aria-expanded", String(open));
  };
  els.sidebar.querySelectorAll("a").forEach((link) => {
    link.onclick = () => {
      els.sidebar.querySelectorAll("a").forEach((item) => item.classList.remove("active"));
      link.classList.add("active");
      els.sidebar.classList.remove("open");
      els.mobileNavToggle.setAttribute("aria-expanded", "false");
    };
  });
}

loadConnection().catch(() => {});
initCustomValuesSection();
