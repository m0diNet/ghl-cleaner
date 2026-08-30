const axios = require("axios");
const { normalizeDeleteJob, toText } = require("./deleteJob");
const {
  buildCustomValueInventory,
  extractCustomValueItems,
} = require("./customValuesImport");

const BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_VERSION = "2021-07-28";

function createClient(token, version) {
  return axios.create({
    baseURL: BASE_URL,
    timeout: 60000,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Version: version || DEFAULT_VERSION,
    },
  });
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

async function requestList({ token, version, endpoint, params, category, arrayPaths, totalPaths = [], locationId = "" }) {
  const response = await createClient(token, version).get(endpoint, { params });
  const raw = firstArray(response.data, arrayPaths);
  return makeResult({ category, raw, data: response.data, totalPaths, locationId });
}

async function scanTags(values) {
  return requestList({
    ...values,
    category: "tags",
    endpoint: `/locations/${values.locationId}/tags`,
    version: "2021-07-28",
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
    version: "2021-07-28",
    params: { model: "all" },
    arrayPaths: ["customFields", "fields", "data.customFields", "data.fields"],
    totalPaths: ["total", "count", "meta.total"],
    locationId: values.locationId,
  });
}

async function scanCustomValues(values) {
  const client = createClient(values.token, "2021-07-28");
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
    version: "2021-07-28",
    params: { locationId: values.locationId },
    arrayPaths: ["links", "triggerLinks", "data.links", "data.triggerLinks", "data"],
    totalPaths: ["total", "count", "meta.total", "data.total", "data.count"],
    locationId: values.locationId,
  });
}

async function scanWorkflows(values) {
  return requestList({
    ...values,
    category: "workflows",
    endpoint: "/workflows/",
    version: "2021-04-15",
    params: { locationId: values.locationId },
    arrayPaths: ["workflows", "data.workflows", "data"],
    totalPaths: ["total", "count", "meta.total", "data.total", "data.count"],
    locationId: values.locationId,
  });
}

async function scanFunnels(values) {
  return requestList({
    ...values,
    category: "funnels",
    endpoint: "/funnels/funnel/list",
    version: "2021-07-28",
    params: { locationId: values.locationId },
    arrayPaths: ["funnels", "data.funnels", "data"],
    totalPaths: ["total", "count", "meta.total", "data.total", "data.count"],
    locationId: values.locationId,
  });
}

async function scanForms(values) {
  const client = createClient(values.token, "2021-07-28");
  const limit = 100;
  const raw = [];
  let skip = 0;
  let reportedTotal = null;
  let lastData = null;
  const seenPageSignatures = new Set();

  for (let page = 0; page < 100; page += 1) {
    const response = await client.get("/forms/", {
      params: {
        locationId: values.locationId,
        limit,
        skip,
      },
    });

    lastData = response.data;
    const batch = firstArray(response.data, ["forms", "data.forms", "data"]);
    const pageTotal = firstNumber(response.data, [
      "total",
      "count",
      "meta.total",
      "data.total",
      "data.count",
    ]);

    if (pageTotal !== null) reportedTotal = pageTotal;

    const signature = batch.map((item) => String(itemId(item) || "")).join("|");
    if (seenPageSignatures.has(signature)) break;
    seenPageSignatures.add(signature);

    raw.push(...batch);

    if (!batch.length) break;
    if (reportedTotal !== null && raw.length >= reportedTotal) break;
    if (batch.length < limit) break;

    skip += batch.length;
  }

  const result = makeResult({
    category: "forms",
    raw,
    data: lastData || {},
    totalPaths: [],
    locationId: values.locationId,
  });

  result.reportedTotal = reportedTotal ?? result.loadedCount;
  result.count = result.loadedCount;
  result.verified =
    result.missingIds === 0 &&
    result.duplicateIds === 0 &&
    result.loadedCount === result.reportedTotal;
  result.status = result.verified ? "verified" : "incomplete";
  result.error = result.verified
    ? null
    : `loaded ${result.loadedCount} of ${result.reportedTotal}`;

  return result;
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
    workflows: scanWorkflows,
    funnels: scanFunnels,
    forms: scanForms,
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
  scanWorkflows,
  scanFunnels,
  scanForms,
};
