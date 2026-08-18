const JOB_ID_KEYS = [
  "resourceId",
  "id",
  "_id",
  "workflowId",
  "funnelId",
  "formId",
  "linkId",
  "tagId",
  "customFieldId",
  "customValueId",
];

const JOB_NAME_KEYS = [
  "resourceName",
  "name",
  "title",
  "fieldKey",
  "key",
  "value",
  "displayName",
];

const JOB_PARENT_ID_KEYS = [
  "parentId",
  "folderId",
];

const JOB_PARENT_NAME_KEYS = [
  "parentName",
  "folderName",
];

const RESERVED_METADATA_KEYS = new Set([
  "locationId",
  "resourceType",
  "resourceId",
  "resourceName",
  "parentId",
  "parentName",
  "metadata",
  "type",
  "id",
  "_id",
  "name",
  "title",
  "fieldKey",
  "key",
  "displayName",
  "workflowId",
  "funnelId",
  "formId",
  "linkId",
  "tagId",
  "customFieldId",
  "customValueId",
]);

function toText(value) {
  return String(value || "").trim();
}

function pickText(source, keys) {
  if (!source || typeof source !== "object") {
    return "";
  }

  for (const key of keys) {
    const value = source[key];
    const text = toText(value);
    if (text) {
      return text;
    }
  }

  return "";
}

function cloneMetadata(source) {
  if (!source || typeof source !== "object") {
    return {};
  }

  const metadata = {};
  const baseMetadata = source.metadata;

  if (baseMetadata && typeof baseMetadata === "object" && !Array.isArray(baseMetadata)) {
    Object.assign(metadata, baseMetadata);
  }

  for (const [key, value] of Object.entries(source)) {
    if (RESERVED_METADATA_KEYS.has(key) || value === undefined) {
      continue;
    }

    metadata[key] = value;
  }

  return metadata;
}

function jobIdentity(item) {
  return pickText(item, JOB_ID_KEYS);
}

function jobName(item) {
  return pickText(item, JOB_NAME_KEYS);
}

function jobParentId(item) {
  return pickText(item, JOB_PARENT_ID_KEYS);
}

function jobParentName(item) {
  return pickText(item, JOB_PARENT_NAME_KEYS);
}

function normalizeDeleteJob(item, fallbackType = "", locationId = "") {
  if (!item || typeof item !== "object") {
    return null;
  }

  const resourceType = toText(item.resourceType || item.type || fallbackType);
  const resourceId = toText(jobIdentity(item));
  const resourceName = toText(item.resourceName || jobName(item));
  const parentId = toText(item.parentId || jobParentId(item));
  const parentName = toText(item.parentName || jobParentName(item));
  const resolvedLocationId = toText(item.locationId || locationId);
  const metadata = cloneMetadata(item);

  if (resolvedLocationId) {
    metadata.locationId = resolvedLocationId;
  }

  return {
    locationId: resolvedLocationId || null,
    resourceType: resourceType || fallbackType || null,
    resourceId: resourceId || null,
    resourceName: resourceName || null,
    parentId: parentId || null,
    parentName: parentName || null,
    metadata,
    id: resourceId || null,
    name: resourceName || null,
    type: resourceType || fallbackType || null,
  };
}

function normalizeDeleteJobs(items, fallbackType = "", locationId = "") {
  return (Array.isArray(items) ? items : [])
    .map((item) => normalizeDeleteJob(item, fallbackType, locationId))
    .filter((item) => item && item.resourceId && item.resourceName);
}

module.exports = {
  jobIdentity,
  jobName,
  jobParentId,
  jobParentName,
  normalizeDeleteJob,
  normalizeDeleteJobs,
  toText,
};
