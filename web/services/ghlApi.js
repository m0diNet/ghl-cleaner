const axios = require("axios");

const BASE_URL =
  "https://services.leadconnectorhq.com";

function createClient(token) {
  return axios.create({
    baseURL: BASE_URL,

    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Version: "2021-07-28",
    },

    timeout: 30000,
  });
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
          item.status === "failed"
      ).length,
  };
}

module.exports = {
  scanApiResources,
  deleteSelectedApiItems,
};
