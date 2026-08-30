const axios = require("axios");
const { normalizeDeleteJob, toText } = require("./deleteJob");
const {
  buildCustomValueInventory,
  extractCustomValueItems,
} = require("./customValuesImport");
const { createGhlClient } = require("./ghlApiConfig");

function createClient(token) {
  return createGhlClient(token, axios.create);
}

function firstArray(data, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((current, key) => current?.[key], data);
    if (Array.isArray(value)) return value;
  }
  if (Array.isArray(data)) return data;
  return [];
}

function firstNumber(data, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((current, key) => current?.[key], data);
    if (value !== undefined && value !== null && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function itemId(item) {
  return toText(
    item?.resourceId ||
      item?.id ||
      item?._id ||
      item?.workflowId ||
      item?.funnelId ||
      item?.formId ||
      item?.linkId ||
      item?.tagId ||
      item?.customFieldId ||
      item?.customValueId ||
      ""
  );
}

function itemName(item) {
  return toText(
    item?.resourceName ||
      item?.name ||
      item?.title ||
      item?.fieldKey ||
      item?.key ||
      item?.value ||
      item?.displayName ||
      "Unnamed item"
  );
}

function normalizeRaw(raw, category, locationId) {
  const unique = new Map();
  let missingIds = 0;
  let duplicateIds = 0;

  for (const source of raw) {
    const normalized = normalizeDeleteJob(source, category, locationId);
    const id = String(normalized?.resourceId || "").trim();
    if (!id) {
      missingIds += 1;
      continue;
    }
    if (unique.has(id)) {
      duplicateIds += 1;
      continue;
    }
    unique.set(id, {
      ...normalized,
      id,
      name: String(normalized.resourceName || itemName(source)).trim(),
      type: category,
      realId: true,
    });
  }

  const items = [...unique.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
  );

  return { items, missingIds, duplicateIds };
}

function makeResult({ category, raw, data, totalPaths = [], locationId }) {
  const { items, missingIds, duplicateIds } = normalizeRaw(raw, category, locationId);
  const reportedTotal = firstNumber(data, totalPaths);
  const countMatches = reportedTotal === null || reportedTotal === items.length;
  const verified = missingIds === 0 && duplicateIds === 0 && countMatches;

  let error = null;
  if (!verified) {
    const problems = [];
    if (missingIds) problems.push(`${missingIds} item(s) missing IDs`);
    if (duplicateIds) problems.push(`${duplicateIds} duplicate ID(s)`);
    if (!countMatches) problems.push(`loaded ${items.length} of ${reportedTotal}`);
    error = problems.join(", ");
  }

  return {
    label: category,
    status: verified ? "verified" : "incomplete",
    verified,
    reportedTotal: reportedTotal ?? items.length,
    loadedCount: items.length,
    count: items.length,
    items,
    missingIds,
    duplicateIds,
    error,
  };
}

async function requestList({ token, endpoint, params, category, arrayPaths, totalPaths = [], locationId = "" }) {
  const response = await createClient(token).get(endpoint, { params });
  const raw = firstArray(response.data, arrayPaths);
  return makeResult({ category, raw, data: response.data, totalPaths, locationId });
}

async function scanTags(values) {
  return requestList({
    ...values,
    category: "tags",
    endpoint: `/locations/${values.locationId}/tags`,
    params: undefined,
    arrayPaths: ["tags", "data.tags"],
    totalPaths: ["total", "count", "meta.total"],
    locationId: values.locationId,
  });
}

async function scanCustomFields(values) {
  return requestList({
    ...values,
    category: "customFields",
    endpoint: `/locations/${values.locationId}/customFields`,
    params: { model: "all" },
    arrayPaths: ["customFields", "fields", "data.customFields", "data.fields"],
    totalPaths: ["total", "count", "meta.total"],
    locationId: values.locationId,
  });
}

async function scanCustomValues(values) {
  const client = createClient(values.token);
  const response = await client.get(`/locations/${values.locationId}/customValues`);
  const raw = extractCustomValueItems(response.data);
  const inventory = buildCustomValueInventory(raw);
  const result = makeResult({
    category: "customValues",
    raw: inventory.items,
    data: response.data,
    totalPaths: ["total", "count", "meta.total", "data.total", "data.count"],
    locationId: values.locationId,
  });

  result.items = inventory.items.map((item) => ({
    ...item,
    id: item.id,
    name: item.name,
    value: item.value,
    folderId: item.folderId,
    folderName: item.folderName,
    metadata: item.metadata,
  }));
  result.folders = inventory.folders;
  result.reportedTotal =
    firstNumber(response.data, ["total", "count", "meta.total", "data.total", "data.count"]) ??
    result.loadedCount;
  result.count = result.loadedCount;
  result.verified =
    result.missingIds === 0 &&
    result.duplicateIds === 0 &&
    result.loadedCount === result.reportedTotal;
  result.status = result.verified ? "verified" : "incomplete";
  result.error = result.verified ? null : `loaded ${result.loadedCount} of ${result.reportedTotal}`;
  return result;
}

async function scanTriggerLinks(values) {
  return requestList({
    ...values,
    category: "triggerLinks",
    endpoint: "/links/",
    params: { locationId: values.locationId },
    arrayPaths: ["links", "triggerLinks", "data.links", "data.triggerLinks", "data"],
    totalPaths: ["total", "count", "meta.total", "data.total", "data.count"],
    locationId: values.locationId,
  });
}

function failed(category, error) {
  return {
    label: category,
    status: "failed",
    verified: false,
    reportedTotal: null,
    loadedCount: 0,
    count: 0,
    items: [],
    missingIds: 0,
    duplicateIds: 0,
    error: error.response?.data?.message || error.response?.data?.error || error.message,
  };
}

async function scanVerifiedResources(values) {
  const scanners = {
    tags: scanTags,
    customFields: scanCustomFields,
    customValues: scanCustomValues,
    triggerLinks: scanTriggerLinks,
  };

  const entries = await Promise.all(
    Object.entries(scanners).map(async ([category, scanner]) => {
      try {
        return [category, await scanner(values)];
      } catch (error) {
        return [category, failed(category, error)];
      }
    })
  );

  return Object.fromEntries(entries);
}

module.exports = {
  scanVerifiedResources,
  scanTags,
  scanCustomFields,
  scanCustomValues,
  scanTriggerLinks,
};
