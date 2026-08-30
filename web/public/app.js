const $ = (id) => document.getElementById(id);

const state = {
  connection: null,
  location: null,
  scanId: null,
  resources: {},
  deletable: [],
  active: null,
  selected: new Map(),
  search: "",
  filter: "all",
  page: 1,
  pageSize: 10,
};

const els = {
  form: $("connection-form"),
  token: $("integration-token"),
  locationId: $("location-id"),
  test: $("test-button"),
  toggle: $("toggle-token"),
  message: $("connection-result"),
  account: $("account-card"),
  accountName: $("account-name"),
  accountLocation: $("account-location"),
  accountInline: $("account-name-inline"),
  selectedLocationInline: $("selected-location-inline"),
  selectedLocationIdInline: $("selected-location-id-inline"),
  disconnect: $("disconnect-button"),
  scan: $("scan-button"),
  inventory: $("inventory"),
  scanStatus: $("scan-status"),
  tabs: $("category-tabs"),
  toolbar: $("resource-toolbar"),
  table: $("resource-table"),
  search: $("global-search"),
  filter: $("selection-filter"),
  selectFiltered: $("select-filtered"),
  clearCategory: $("clear-category"),
  deleteCategory: $("delete-category"),
  rescan: $("rescan-button"),
  bulk: $("bulk-bar"),
  bulkCount: $("bulk-count"),
  clearAll: $("clear-all-selection"),
  deleteSelected: $("delete-selected"),
  danger: $("danger"),
  deleteAll: $("delete-all"),
  modal: $("modal"),
  modalContent: $("modal-content"),
  modalClose: $("modal-close"),
  topStatus: $("top-status"),
};

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function msg(text, type = "") {
  els.message.className = `message ${type}`;
  els.message.textContent = text;
  els.message.classList.remove("hidden");
}

function formatConnectionError(data) {
  const code = String(data?.code || "").trim();
  const fallback = String(data?.details || data?.message || "Connection failed.").trim();
  const map = {
    INVALID_TOKEN: "Authentication failed. Check your Private Integration Token.",
    AUTHENTICATION_FAILED: "Authentication failed. Check your Private Integration Token.",
    TOKEN_VALID_BUT_FORBIDDEN: "The token is valid, but it does not have the required permission to list locations.",
    NO_ACCESSIBLE_LOCATIONS: "This token did not return any accessible GHL locations.",
    LOCATION_NOT_AUTHORIZED: "This token does not have access to the selected GHL location.",
    LOCATION_ACCESS_FORBIDDEN: "The token does not have permission to access this location.",
    LOCATION_NOT_FOUND_OR_INACCESSIBLE: "Location not found or this token cannot access that Location ID.",
    RATE_LIMITED: "HighLevel rate limit reached. Try again shortly.",
    HIGHLEVEL_UNAVAILABLE: "Unable to reach HighLevel right now.",
    NETWORK_ERROR: "Unable to reach HighLevel right now.",
    UNKNOWN_AUTH_ERROR: "HighLevel rejected the connection request.",
    HIGHLEVEL_REQUEST_FAILED: "HighLevel rejected the connection request.",
  };

  return map[code] || fallback;
}

function setFor(category) {
  if (!state.selected.has(category)) {
    state.selected.set(category, new Set());
  }
  return state.selected.get(category);
}

function totalSelected() {
  return [...state.selected.values()].reduce((sum, set) => sum + set.size, 0);
}

function cloneJobItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  return {
    ...item,
    metadata:
      item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
        ? { ...item.metadata }
        : item.metadata || {},
  };
}

function payload() {
  const body = {};
  for (const [category, ids] of state.selected) {
    body[category] = (state.resources[category]?.items || [])
      .filter((item) => ids.has(item.id))
      .map((item) => cloneJobItem(item));
  }
  return body;
}

function counts() {
  return Object.fromEntries(
    Object.entries(state.resources).map(([category, resource]) => [
      category,
      Number(resource.count || 0),
    ])
  );
}

function metrics() {
  const loaded = Object.values(state.resources).reduce((sum, resource) => sum + resource.items.length, 0);
  $("metric-total").textContent = loaded;
  $("metric-categories").textContent = Object.values(state.resources).filter((resource) => resource.count > 0).length;
  $("metric-selected").textContent = totalSelected();
  $("metric-ready").textContent = state.deletable.length;
  els.bulk.classList.toggle("hidden", !totalSelected());
  els.bulkCount.textContent = `${totalSelected()} selected`;
  categoryButton();
}

function items() {
  const resource = state.resources[state.active];
  if (!resource) {
    return [];
  }

  const query = state.search.toLowerCase();
  return resource.items.filter((item) => {
    const haystack = [
      item.name,
      item.value,
      item.folderName,
      item.parentName,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchesSearch = haystack.includes(query);
    const selected = setFor(state.active).has(item.id);
    const matchesFilter =
      state.filter === "all" ||
      (state.filter === "selected" && selected) ||
      (state.filter === "unselected" && !selected);
    return matchesSearch && matchesFilter;
  });
}

function pageItems(list) {
  const start = (state.page - 1) * state.pageSize;
  return list.slice(start, start + state.pageSize);
}

function pagination(total) {
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  state.page = Math.min(state.page, pages);
  if (pages === 1 && total <= state.pageSize) return "";
  return `
    <div class="pagination">
      <button class="ghost page-prev" type="button" ${state.page === 1 ? "disabled" : ""}>Previous</button>
      <span>Page ${state.page} of ${pages} · ${total} matching</span>
      <button class="ghost page-next" type="button" ${state.page === pages ? "disabled" : ""}>Next</button>
      <label>Rows <select class="page-size"><option ${state.pageSize === 10 ? "selected" : ""}>10</option><option ${state.pageSize === 25 ? "selected" : ""}>25</option><option ${state.pageSize === 50 ? "selected" : ""}>50</option><option ${state.pageSize === 100 ? "selected" : ""}>100</option></select></label>
    </div>`;
}

function wirePagination(total) {
  const previous = els.table.querySelector(".page-prev");
  const next = els.table.querySelector(".page-next");
  const size = els.table.querySelector(".page-size");
  if (previous) previous.onclick = () => { state.page -= 1; table(); };
  if (next) next.onclick = () => { state.page += 1; table(); };
  if (size) size.onchange = () => { state.pageSize = Number(size.value); state.page = 1; table(); };
}

function tabs() {
  els.tabs.innerHTML = "";

  for (const [category, resource] of Object.entries(state.resources)) {
    const button = document.createElement("button");
    button.className = `tab ${state.active === category ? "active" : ""}`;
    button.innerHTML = `${esc(resource.label)} <b>${resource.count}</b>`;
    button.onclick = () => {
      state.active = category;
      state.search = "";
      state.filter = "all";
      els.search.value = "";
      els.filter.value = "all";
      tabs();
      table();
    };
    els.tabs.appendChild(button);
  }
}

function table() {
  const resource = state.resources[state.active];
  els.toolbar.classList.toggle("hidden", !resource);

  if (!resource) {
    els.table.innerHTML = '<div class="empty">Choose a category.</div>';
    return;
  }

  if (state.active === "customValues") {
    renderCustomValuesInventory(resource);
    return;
  }

  const filtered = items();
  const list = pageItems(filtered);
  const ready = resource.verified === true;
  const statusText = ready
    ? `Verified ${resource.loadedCount}/${resource.reportedTotal ?? resource.loadedCount}`
    : `Incomplete ${resource.loadedCount || 0}/${resource.reportedTotal ?? "?"}`;

  els.table.innerHTML = `
    <div class="scan-proof ${ready ? "verified" : "incomplete"}">
      <strong>${esc(statusText)}</strong>
      ${resource.error ? `<span>${esc(resource.error)}</span>` : ""}
    </div>
    <div class="table-head">
      <span></span><span>Name</span><span>ID</span><span>Status</span>
    </div>
    ${
      list.length
        ? list
            .map(
              (item) => `
                <label class="table-row">
                  <input type="checkbox" data-id="${esc(item.id)}" ${ready ? "" : "disabled"} ${
                setFor(state.active).has(item.id) ? "checked" : ""
              }>
                  <span class="item-name">${esc(item.name)}</span>
                  <code>${esc(item.id)}</code>
                  <span class="badge ${ready ? "ready" : ""}">${ready ? "Verified" : "Deletion blocked"}</span>
                </label>
              `
            )
            .join("")
        : '<div class="empty">No matching items.</div>'
    }
    ${pagination(filtered.length)}`;

  els.table.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.onchange = () => {
      if (checkbox.checked) {
        setFor(state.active).add(checkbox.dataset.id);
      } else {
        setFor(state.active).delete(checkbox.dataset.id);
      }
      metrics();
    };
  });

  wirePagination(filtered.length);
  categoryButton();
}

function categoryButton() {
  if (!els.deleteCategory) {
    return;
  }

  const resource = state.resources[state.active];
  const selectedCount = setFor(state.active).size;
  const ready = state.deletable.includes(state.active);
  els.deleteCategory.classList.toggle("hidden", !resource || !ready);
  els.deleteCategory.disabled = !selectedCount;
  els.deleteCategory.textContent = resource
    ? `Delete selected ${resource.label.toLowerCase()} (${selectedCount})`
    : "Delete selected category";
}

async function scan() {
  els.scan.disabled = els.rescan.disabled = true;
  els.scanStatus.textContent = "Scanning through the API and audit engine…";
  els.inventory.classList.remove("hidden");

  try {
    const response = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.details || data.message || "Scan failed");
    }

    state.resources = data.resources || {};
    state.deletable = data.deletableCategories || [];
    state.location = data.location;
    state.scanId = data.scanId;
    state.selected.clear();
    state.active = Object.keys(state.resources).find((key) => state.resources[key].count > 0) || Object.keys(state.resources)[0];

    els.scanStatus.className = "message success";
    els.scanStatus.textContent = data.allVerified
      ? "Verified scan complete. Every deletable category is complete."
      : "Scan finished, but some categories are incomplete. Deletion is blocked for those categories.";
    els.danger.classList.remove("hidden");
    tabs();
    table();
    metrics();
  } catch (error) {
    els.scanStatus.className = "message error";
    els.scanStatus.textContent = error.message;
  } finally {
    els.scan.disabled = els.rescan.disabled = false;
  }
}

// Custom Value creation/import is intentionally absent from the delete engine.

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

function renderCustomValuesResult({ created = 0, updated = 0, unchanged = 0, failed = 0, folderAssociationVerified = false, note = "" }) {
  els.customResult.className = "message success";
  els.customResult.innerHTML = `
    <div class="custom-values-summary">
      <strong>Custom Values</strong>
      <span>Created: ${esc(created)}</span>
      <span>Updated: ${esc(updated)}</span>
      <span>Skipped: ${esc(unchanged)}</span>
      <span>Failed: ${esc(failed)}</span>
      <span>Folder Association Verified: ${folderAssociationVerified ? "Yes" : "No"}</span>
      ${note ? `<small>${esc(note)}</small>` : ""}
    </div>
  `;
  els.customResult.classList.remove("hidden");
}

function renderCustomValuesError(text) {
  els.customResult.className = "message error";
  els.customResult.textContent = text;
  els.customResult.classList.remove("hidden");
}

function renderCustomValuesInventoryPanel() {
  const inventory = state.customValuesInventory || {};
  const items = Array.isArray(inventory.items) ? inventory.items : [];
  const folders = Array.isArray(inventory.folders) ? inventory.folders : [];
  const folderSummary = folders
    .map(
      (folder) =>
        `<span class="chip">${esc(folder.folderName || "")}${folder.folderId ? ` <code>${esc(folder.folderId)}</code>` : ""}</span>`
    )
    .join("");

  if (!els.customInventory) {
    return;
  }

  if (inventory.error) {
    els.customInventory.innerHTML = `<div class="empty">${esc(inventory.error)}</div>`;
    els.customInventory.classList.remove("hidden");
    return;
  }

  els.customInventory.innerHTML = `
    <div class="custom-values-inventory-summary">
      <span>${esc(items.length)} values</span>
      <span>${esc(folders.length)} folders</span>
    </div>
    ${folders.length ? `<div class="custom-values-folder-chips">${folderSummary}</div>` : ""}
    <div class="table-head custom-values-head">
      <span>Name</span><span>Value</span><span>Folder</span><span>Status</span><span>ID</span>
    </div>
    ${
      items.length
        ? items
            .map(
              (item) => `
                <div class="table-row custom-values-row">
                  <span class="item-name">${esc(item.name || "")}</span>
                  <span>${esc(item.value || "")}</span>
                  <span>${esc(item.folderName || "")}</span>
                  <span class="badge ${item.folderName ? "ready" : "incomplete"}">${item.folderName ? "Foldered" : "Unfiled"}</span>
                  <span><code>${esc(item.folderId || item.id || "")}</code></span>
                </div>
              `
            )
            .join("")
        : '<div class="empty">No custom values were returned for this location.</div>'
    }
  `;
  els.customInventory.classList.remove("hidden");
}

async function refreshCustomValuesInventory() {
  const connection = currentConnection();
  if (!connection || !selectedLocationId()) {
    return;
  }

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
      loaded: true,
      error: "",
    };
  } catch (error) {
    state.customValuesInventory = {
      items: [],
      folders: [],
      loaded: false,
      error: error.message,
    };
  }

  renderCustomValuesInventoryPanel();
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
      </div>
      ${
        rows.length
          ? rows
              .map(
                (row) => `
                  <div class="table-row custom-values-preview-row ${esc(row.action || "")}">
                    <span class="badge ${esc(String(row.action || "").toLowerCase())}">${esc(row.action || "")}</span>
                    <span>${esc(row.name || "")}</span>
                    <span>${esc(row.existingValue || "")}</span>
                    <span>${esc(row.importedValue || "")}</span>
                    <span>${esc(row.existingFolder || "")}</span>
                    <span>${esc(row.targetFolder || "")}</span>
                  </div>
                `
              )
              .join("")
          : '<div class="empty">No rows to preview.</div>'
      }
    </div>
  `;
  els.customPreviewWrap.classList.remove("hidden");
  els.customConfirm.disabled = !(previewResult && rows.length);
}

function customValuesTableRows(resource) {
  const rows = Array.isArray(resource?.items) ? resource.items : [];
  if (state.active !== "customValues") {
    return rows;
  }
  return rows;
}

function renderCustomValuesInventory(resource) {
  if (!resource) {
    return;
  }

  if (state.active !== "customValues") {
    return;
  }

  const filtered = items();
  const list = pageItems(filtered);
  const ready = resource.verified === true;
  const statusText = ready
    ? `Verified ${resource.loadedCount}/${resource.reportedTotal ?? resource.loadedCount}`
    : `Incomplete ${resource.loadedCount || 0}/${resource.reportedTotal ?? "?"}`;

  els.table.innerHTML = `
    <div class="scan-proof ${ready ? "verified" : "incomplete"}">
      <strong>${esc(statusText)}</strong>
      ${resource.error ? `<span>${esc(resource.error)}</span>` : ""}
    </div>
    <div class="table-head custom-values-head">
      <span></span><span>Name</span><span>ID</span><span>Value</span><span>Folder</span><span>Status</span>
    </div>
    ${
      list.length
        ? list
            .map(
              (item) => `
                <label class="table-row custom-values-row">
                  <input type="checkbox" data-id="${esc(item.id)}" ${ready ? "" : "disabled"} ${
                setFor(state.active).has(item.id) ? "checked" : ""
                  }>
                  <span class="item-name">${esc(item.name)}</span>
                  <code>${esc(item.id)}</code>
                  <span>${esc(item.value || "")}</span>
                  <span>${esc(item.folderName || "")}</span>
                  <span class="badge ${ready ? "ready" : ""}">${ready ? "Verified" : "Deletion blocked"}</span>
                </label>
              `
            )
            .join("")
        : '<div class="empty">No matching items.</div>'
    }
    ${pagination(filtered.length)}`;

  els.table.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.onchange = () => {
      if (checkbox.checked) {
        setFor(state.active).add(checkbox.dataset.id);
      } else {
        setFor(state.active).delete(checkbox.dataset.id);
      }
      metrics();
    };
  });
  wirePagination(filtered.length);
  categoryButton();
}

function currentConnection() {
  return state.connection || null;
}

function selectedLocationId() {
  return String(state.connection?.selectedLocationId || state.connection?.locationId || "").trim();
}

function canOperate() {
  return Boolean(currentConnection() && selectedLocationId());
}

function syncConnectionUI() {
  const connection = currentConnection();
  const selected = connection?.selectedLocation || null;
  const connected = Boolean(connection);
  const ready = Boolean(connection && selectedLocationId());
  const displayLocationId = selected?.id || connection?.selectedLocationId || "-";

  els.account.classList.toggle("hidden", !connected);
  els.accountName.textContent = connection?.accountName || connection?.companyName || "Not connected";
  els.accountLocation.textContent = displayLocationId;
  els.accountInline.textContent = connection?.accountName || connection?.companyName || "Not connected";
  els.selectedLocationInline.textContent = selected?.name || connection?.selectedLocationName || "-";
  els.selectedLocationIdInline.textContent = selected?.id || connection?.selectedLocationId || "-";
  els.topStatus.textContent = ready ? "Connected" : "Not connected";
  els.scan.disabled = !ready;
  els.disconnect.disabled = !connected;
  els.test.disabled = false;
  els.selectFiltered.disabled = !ready;
  els.clearCategory.disabled = !ready;
  els.deleteCategory.disabled = !ready || !state.active;
  els.deleteSelected.disabled = !ready;
  els.deleteAll.disabled = !ready;
  els.rescan.disabled = !ready;
}

function applyConnection(connection, options = {}) {
  state.connection = connection || null;
  if (connection) {
    els.account.classList.remove("hidden");
    els.accountName.textContent = connection.accountName || connection.companyName || "Connected GHL Account";
    els.accountLocation.textContent = connection.selectedLocationId || "-";
    els.locationId.value = connection.selectedLocationId || "";
  } else {
    els.account.classList.add("hidden");
    els.accountName.textContent = "-";
    els.accountLocation.textContent = "-";
    els.accountInline.textContent = "Not connected";
    els.selectedLocationInline.textContent = "-";
    els.selectedLocationIdInline.textContent = "-";
    els.locationId.value = "";
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
    } else {
      applyConnection(null, { silent: true });
    }
  } catch {
    applyConnection(null, { silent: true });
  }
  syncConnectionUI();
}

async function disconnectConnection() {
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
  }
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

async function previewCustomValuesImport() {
  const connection = currentConnection();
  const locationId = selectedLocationId();
  const folderName = els.customFolder.value.trim();
  const file = els.customImportFile.files?.[0] || null;

  if (!connection || !locationId) {
    renderCustomValuesError("Connect the account before previewing Custom Value imports.");
    return;
  }

  if (!file) {
    renderCustomValuesError("Choose a CSV or XLSX file to preview.");
    return;
  }

  els.customPreview.classList.add("loading");
  els.customPreview.disabled = true;

  try {
    const payload = await readFilePayload(file);
    const response = await fetch("/api/custom-values/import-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetFolderName: folderName,
        ...payload,
      }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.details || data.message || "Custom values preview failed");
    }

    state.customValuesImport.file = payload;
    state.customValuesImport.preview = data;
    renderCustomValuesPreview(data);
    renderCustomValuesResult({
      created: data.counts?.create || 0,
      updated: data.counts?.update || 0,
      unchanged: data.counts?.unchanged || 0,
      failed: (data.counts?.conflict || 0) + (data.counts?.invalid || 0),
      folderAssociationVerified: false,
      note: "Preview ready.",
    });
  } catch (error) {
    renderCustomValuesError(error.message);
  } finally {
    els.customPreview.classList.remove("loading");
    els.customPreview.disabled = false;
  }
}

async function confirmCustomValuesImport() {
  const connection = currentConnection();
  const locationId = selectedLocationId();
  const folderName = els.customFolder.value.trim();
  const file = state.customValuesImport.file || null;
  const preview = state.customValuesImport.preview || null;

  if (!connection || !locationId) {
    renderCustomValuesError("Connect the account before importing Custom Values.");
    return;
  }

  if (!file || !preview) {
    renderCustomValuesError("Preview the import before confirming it.");
    return;
  }

  els.customConfirm.disabled = true;

  try {
    const response = await fetch("/api/custom-values/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetFolderName: folderName,
        ...file,
        mode: "execute",
      }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.details || data.message || "Custom values import failed");
    }

    renderCustomValuesResult({
      created: Number(data.created || 0),
      updated: Number(data.updated || 0),
      unchanged: Number(data.unchanged || 0),
      failed: Number(data.failed || 0),
      folderAssociationVerified: Boolean(data.folderAssociationVerified),
      note: data.error || "",
    });
    state.customValuesImport.file = null;
    state.customValuesImport.preview = null;
    renderCustomValuesPreview(null);
    refreshCustomValuesInventory();
    await scan();
  } catch (error) {
    renderCustomValuesError(error.message);
  } finally {
    els.customConfirm.disabled = false;
  }
}

async function submitCustomValues(event) {
  event.preventDefault();

  const connection = currentConnection();
  const locationId = selectedLocationId();
  const folderName = els.customFolder.value.trim();
  const { values, hasPartialRow } = readCustomValues();

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
    renderCustomValuesResult({ created: 0, updated: 0, unchanged: 0, failed: 0, folderAssociationVerified: false, note: "No Custom Values were provided." });
    return;
  }

  if (folderName && !values.length) {
    renderCustomValuesResult({ created: 0, updated: 0, unchanged: 0, failed: 0, folderAssociationVerified: false, note: "No Custom Values were provided." });
    return;
  }

  const customControls = [els.customSubmit, els.customAdd].filter(Boolean);
  customControls.forEach((control) => {
    control.disabled = true;
  });

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
    if (!response.ok || !data.success) {
      throw new Error(data.details || data.message || "Custom Values setup failed");
    }

    const created = Array.isArray(data.values)
      ? data.values.filter((item) => item.status === "created").length
      : Number(data.created || 0);
    const existing = Array.isArray(data.values)
      ? data.values.filter((item) => item.status === "existing" || item.status === "skipped").length
      : Number(data.skipped || 0);
    const failed = Array.isArray(data.values)
      ? data.values.filter((item) => item.status === "failed").length + (data.folderStatus === "failed" ? 1 : 0)
      : Number(data.failed || 0) + (data.folderStatus === "failed" ? 1 : 0);

    renderCustomValuesResult({
      created,
      updated: 0,
      unchanged: existing,
      failed,
      folderAssociationVerified: Boolean(data.folderStatus && data.folderStatus !== "failed"),
      note: data.message || "",
    });
    refreshCustomValuesInventory();
  } catch (error) {
    renderCustomValuesError(error.message);
  } finally {
    customControls.forEach((control) => {
      control.disabled = false;
    });
  }
}

function review(url, body, title, description, rows) {
  const expected = rows.length === 1 ? "DELETE" : `DELETE ${rows.length} ITEMS`;
  els.modalContent.innerHTML = `
    <h2>${esc(title)}</h2>
    <p>${esc(description)}</p>
    <div class="modal-list">${rows.map((value) => `<div>${esc(value)}</div>`).join("")}</div>
    <label>Type <strong>${esc(expected)}</strong> to confirm</label>
    <input id="delete-confirm" class="confirm-input" autocomplete="off">
    <div id="delete-progress"></div>
    <div class="modal-actions">
      <button class="ghost" id="cancel-delete">Cancel</button>
      <button class="danger" id="confirm-delete" disabled>Delete selected</button>
    </div>
  `;
  els.modal.classList.remove("hidden");
  $("cancel-delete").onclick = () => els.modal.classList.add("hidden");
  const confirm = $("delete-confirm");
  const button = $("confirm-delete");
  confirm.oninput = () => { button.disabled = confirm.value !== expected; };
  button.onclick = () => perform(url, body);
}

function showCategory() {
  const category = state.active;
  const selectedPayload = payload();
  const list = selectedPayload[category] || [];
  const resource = state.resources[category];

  review(
    "/api/delete-category",
    { scanId: state.scanId, category, selections: selectedPayload },
    `Delete ${list.length} selected ${resource.label.toLowerCase()}?`,
    "These exact items will be deleted through the API and verified with a fresh readback.",
    list.map((item) => item.resourceName || item.name)
  );
}

function showSelected() {
  const selectedPayload = payload();
  const list = Object.entries(selectedPayload).flatMap(([category, entries]) =>
    entries.map((item) => `${state.resources[category]?.label || category} — ${item.resourceName || item.name}`)
  );

  review(
    "/api/delete-selected",
    { scanId: state.scanId, selections: selectedPayload },
    `Delete ${list.length} selected item${list.length === 1 ? "" : "s"}?`,
    "Only these exact IDs will be deleted through the API and checked with a fresh readback.",
    list
  );
}

function showAll() {
  const categories = ["tags", "customFields", "customValues", "triggerLinks"].filter(
    (category) => state.resources[category]
  );

  els.modalContent.innerHTML = `
    <h2>Delete everything supported?</h2>
    <p>Choose supported API categories. A fresh inventory is scanned before deletion.</p>
    <div class="category-choice-list">
      ${categories
        .map((category) => {
          const resource = state.resources[category];
          const disabled = !Number(resource.count || 0);
          return `
            <label class="category-choice ${disabled ? "disabled" : ""}">
              <input type="checkbox" class="delete-all-category" value="${esc(category)}" ${disabled ? "disabled" : "checked"}>
              <span>
                <strong>${esc(resource.label)}</strong>
                <small>${resource.count} found · API</small>
              </span>
            </label>
          `;
        })
        .join("")}
    </div>
    <label>Type <strong>DELETE EVERYTHING</strong></label>
    <input id="delete-all-confirm" class="confirm-input" autocomplete="off">
    <div id="delete-progress"></div>
    <div class="modal-actions">
      <button class="ghost" id="cancel-delete">Cancel</button>
      <button class="danger" id="confirm-delete-all" disabled>Delete chosen categories</button>
    </div>
  `;
  els.modal.classList.remove("hidden");
  const confirm = $("delete-all-confirm");
  const button = $("confirm-delete-all");
  confirm.oninput = () => {
    button.disabled = confirm.value !== "DELETE EVERYTHING";
  };
  $("cancel-delete").onclick = () => els.modal.classList.add("hidden");
  button.onclick = () =>
    perform("/api/delete-all", {
      scanId: state.scanId,
      confirmation: confirm.value,
      categories: [...els.modalContent.querySelectorAll(".delete-all-category:checked")].map((input) => input.value),
      scanCounts: counts(),
    });
}

async function perform(url, body) {
  const progress = $("delete-progress");
  progress.className = "message";
  progress.textContent = "Cleanup started. Each API item will be verified with a fresh readback.";
  els.modalContent.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.details || data.message || "Deletion failed");
    }

    progress.className = "message success";
    progress.innerHTML = `
      Deleted <strong>${data.deleted}</strong>. Failed <strong>${data.failed}</strong>. Verification failed <strong>${data.verificationFailed || 0}</strong>. Skipped <strong>${data.skipped || 0}</strong>.
      <div class="modal-list">
        ${(data.results || [])
          .map(
              (result) => `
              <div class="result-row ${esc(result.status)}">
                <span>${esc(result.status)}</span>
                <strong>${esc(result.resourceName || result.name || result.category)}</strong>
                ${result.error ? `<small>${esc(result.error)}</small>` : ""}
              </div>
            `
          )
          .join("")}
      </div>
      <button id="scan-again" class="primary">Scan again</button>
    `;
    $("scan-again").onclick = () => {
      els.modal.classList.add("hidden");
      scan();
    };
  } catch (error) {
    progress.className = "message error";
    progress.textContent = error.message;
  }
}

els.toggle.onclick = () => {
  const hidden = els.token.type === "password";
  els.token.type = hidden ? "text" : "password";
  els.toggle.textContent = hidden ? "Hide" : "Show";
};

els.form.onsubmit = async (event) => {
  event.preventDefault();
  const token = els.token.value.trim();
  const locationId = els.locationId.value.trim();
  if (!token) {
    msg("Enter a Private Integration Token.", "error");
    els.token.focus();
    return;
  }
  if (!locationId) {
    msg("Enter a GHL Location ID.", "error");
    els.locationId.focus();
    return;
  }
  els.test.disabled = true;
  msg("Connecting…");

  try {
    const response = await fetch("/api/connection/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, locationId }),
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(formatConnectionError(data));
    }

    applyConnection(data.connection || {
      accountName: data.locationName || "Connected GHL Account",
      companyName: "",
      selectedLocationId: data.locationId || locationId,
      selectedLocation: { id: data.locationId || locationId, name: data.locationName || "" },
    }, { silent: true });
    els.accountName.textContent = data.locationName || data.connection?.accountName || "Connected GHL Account";
    els.accountLocation.textContent = data.locationId || locationId;
    els.account.classList.remove("hidden");
    els.topStatus.textContent = "Connected";
    els.token.value = "";
    els.token.type = "password";
    els.toggle.textContent = "Show";
    msg("Connection successful.", "success");
    syncConnectionUI();
  } catch (error) {
    msg(error.message, "error");
  } finally {
    els.test.disabled = false;
  }
};

els.disconnect.onclick = disconnectConnection;

els.scan.onclick = els.rescan.onclick = scan;
els.search.oninput = () => {
  state.search = els.search.value;
  state.page = 1;
  table();
};
els.filter.onchange = () => {
  state.filter = els.filter.value;
  state.page = 1;
  table();
};
els.selectFiltered.onclick = () => {
  items().forEach((item) => setFor(state.active).add(item.id));
  table();
  metrics();
};
els.clearCategory.onclick = () => {
  setFor(state.active).clear();
  table();
  metrics();
};
els.clearAll.onclick = () => {
  state.selected.clear();
  table();
  metrics();
};
els.modalClose.onclick = () => els.modal.classList.add("hidden");
els.modal.onclick = (event) => {
  if (event.target === els.modal) {
    els.modal.classList.add("hidden");
  }
};
els.deleteCategory.onclick = showCategory;
els.deleteSelected.onclick = showSelected;
els.deleteAll.onclick = showAll;

syncConnectionUI();
loadConnection();
