const axios = require("axios");
const { createGhlClient } = require("./ghlApiConfig");

function createClient(token) {
  return createGhlClient(token, axios.create);
}

function extractArray(data, possibleKeys) {
  for (const key of possibleKeys) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }

  if (Array.isArray(data)) {
    return data;
  }

  return [];
}

function normalizeItem(item, category) {
  return {
    id:
      item.id ||
      item._id ||
      item.tagId ||
      item.customFieldId ||
      item.customValueId,

    name:
      item.name ||
      item.fieldKey ||
      item.key ||
      item.value ||
      "Unnamed item",

    type: category,
  };
}

async function scanApiResources({
  locationId,
  token,
}) {
  const client =
    createClient(token);

  const resources = {
    tags: [],
    customFields: [],
    customValues: [],
    triggerLinks: [],
  };

  const results =
    await Promise.allSettled([
      client.get(
        `/locations/${locationId}/tags`
      ),

      client.get(
        `/locations/${locationId}/customFields`,
        {
          params: {
            model: "all",
          },
        }
      ),

      client.get(
        `/locations/${locationId}/customValues`
      ),

      client.get(`/links/`, { params: { locationId } }),
    ]);

  if (results[0].status === "fulfilled") {
    resources.tags =
      extractArray(
        results[0].value.data,
        ["tags"]
      )
        .map((item) =>
          normalizeItem(item, "tags")
        )
        .filter((item) => item.id);
  }

  if (results[1].status === "fulfilled") {
    resources.customFields =
      extractArray(
        results[1].value.data,
        [
          "customFields",
          "fields",
        ]
      )
        .map((item) =>
          normalizeItem(
            item,
            "customFields"
          )
        )
        .filter((item) => item.id);
  }

  if (results[2].status === "fulfilled") {
    resources.customValues =
      extractArray(
        results[2].value.data,
        [
          "customValues",
          "values",
        ]
      )
        .map((item) =>
          normalizeItem(
            item,
            "customValues"
          )
        )
        .filter((item) => item.id);
  }

  if (results[3].status === "fulfilled") {
    resources.triggerLinks = extractArray(results[3].value.data, ["links", "triggerLinks", "data"])
      .map((item) => ({
        id: item.id || item._id || item.linkId,
        name: item.name || item.title || "Unnamed trigger link",
        type: "triggerLinks",
      }))
      .filter((item) => item.id);
  }

  return resources;
}

function getDeletePath(
  category,
  locationId,
  itemId
) {
  const safeLocationId =
    encodeURIComponent(locationId);

  const safeItemId =
    encodeURIComponent(itemId);

  const paths = {
    tags:
      `/locations/${safeLocationId}/tags/${safeItemId}`,

    customFields:
      `/locations/${safeLocationId}/customFields/${safeItemId}`,

    customValues:
      `/locations/${safeLocationId}/customValues/${safeItemId}`,

    triggerLinks:
      `/links/${safeItemId}`,
  };

  return paths[category] || null;
}

async function deleteSelectedApiItems({
  locationId,
  token,
  selections,
}) {
  const client =
    createClient(token);

  const supportedCategories = [
    "tags",
    "customFields",
    "customValues",
    "triggerLinks",
  ];

  const results = [];

  for (const category of supportedCategories) {
    const items =
      Array.isArray(selections[category])
        ? selections[category]
        : [];

    for (const item of items) {
      const itemId =
        String(item.id || "").trim();

      const itemName =
        String(
          item.name ||
          "Unnamed item"
        ).trim();

      if (!itemId) {
        results.push({
          category,
          id: null,
          name: itemName,
          status: "failed",
          error: "Missing real GHL item ID.",
        });

        continue;
      }

      const deletePath =
        getDeletePath(
          category,
          locationId,
          itemId
        );

      try {
        await client.delete(deletePath);

        results.push({
          category,
          id: itemId,
          name: itemName,
          status: "deleted",
          error: null,
        });
      } catch (error) {
        results.push({
          category,
          id: itemId,
          name: itemName,
          status: "failed",

          error:
            error.response?.data?.message ||
            error.response?.data?.error ||
            error.message,
        });
      }
    }
  }

  const verification = await verifyDeletedItems({
    client,
    locationId,
    results,
  });

  return {
    results,

    deleted:
      results.filter(
        (item) =>
          item.status === "deleted"
      ).length,

    failed:
      results.filter(
        (item) =>
          item.status === "failed" || item.status === "verification_failed"
      ).length,

    verificationFailed: verification.verificationFailed,
  };
}

async function verifyDeletedItems({ client, locationId, results }) {
  let verificationFailed = 0;
  await Promise.all(results.filter((result) => result.id).map(async (result) => {
    try {
      await client.get(getDeletePath(result.category, locationId, result.id));
      result.verificationStatus = "failed";
      if (result.status === "deleted") result.status = "verification_failed";
      result.verificationError = "Resource is still present after DELETE.";
      result.error = result.error || result.verificationError;
      verificationFailed += 1;
    } catch (error) {
      if (isResourceGoneError(error, result.category)) {
        result.verificationStatus = "verified";
      } else {
        result.verificationStatus = "failed";
        if (result.status === "deleted") result.status = "verification_failed";
        result.verificationError = error.response?.data?.message || error.response?.data?.error || error.message;
        result.error = result.error || result.verificationError;
        verificationFailed += 1;
      }
    }
  }));

  return { verificationFailed };
}

function isResourceGoneError(error, category) {
  const status = Number(error.response?.status || 0);
  if (status === 404) return true;
  if (status && (status === 401 || status === 403 || status === 429 || status >= 500)) return false;

  const message = String(
    error.response?.data?.message ||
    error.response?.data?.error ||
    error.message ||
    ""
  ).toLowerCase();
  if (!message) return false;
  if (/not found|does not exist|no such resource/.test(message)) return true;

  const absencePatterns = {
    tags: [/\btag\s+id\s+is\s+invalid\b/],
    customFields: [
      /\bcustom\s+field\s+id\s+is\s+invalid\b/,
      /\bcustom\s+field\s+id\s+or\s+field[_\s-]*key\s+is\s+invalid\b/,
    ],
    customValues: [/\bcustom\s+value\s+id\s+is\s+invalid\b/],
    triggerLinks: [/\btrigger\s+link\s+id\s+is\s+invalid\b/],
  }[category] || [];
  return absencePatterns.some((pattern) => pattern.test(message));
}

module.exports = {
  scanApiResources,
  deleteSelectedApiItems,
  verifyDeletedItems,
  isResourceGoneError,
};
