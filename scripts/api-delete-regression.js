require("dotenv").config({ quiet: true });

const assert = require("assert");
const axios = require("axios");

const LOCATION_ID = "regression-location";
const TOKEN = "regression-token";

async function main() {
  const deleteCalls = [];
  const readCalls = [];
  const originalCreate = axios.create;

  axios.create = () => ({
    delete: async (url) => {
      deleteCalls.push(url);
      return {
        status: 204,
        data: {},
      };
    },
    get: async (url) => {
      readCalls.push(url);
      const error = new Error("not found");
      error.response = { status: 404 };
      throw error;
    },
  });

  try {
    const { deleteSelectedApiItems } = require("../web/services/ghlApi");

    const selections = {
      tags: [
        {
          id: "tag-123",
          name: "Tag One",
        },
      ],
      customFields: [
        {
          id: "field-456",
          name: "Field One",
        },
      ],
      customValues: [
        {
          id: "value-789",
          name: "Value One",
        },
      ],
      triggerLinks: [
        {
          id: "link-abc",
          name: "Trigger Link One",
        },
      ],
      workflows: [
        {
          id: "workflow-should-not-delete",
          name: "Workflow One",
        },
      ],
      funnels: [
        {
          id: "funnel-should-not-delete",
          name: "Funnel One",
        },
      ],
      forms: [
        {
          id: "form-should-not-delete",
          name: "Form One",
        },
      ],
    };

    const result = await deleteSelectedApiItems({
      locationId: LOCATION_ID,
      token: TOKEN,
      selections,
    });

    const expectedUrls = [
      `/locations/${encodeURIComponent(LOCATION_ID)}/tags/tag-123`,
      `/locations/${encodeURIComponent(LOCATION_ID)}/customFields/field-456`,
      `/locations/${encodeURIComponent(LOCATION_ID)}/customValues/value-789`,
      `/links/link-abc`,
    ];

    assert.deepStrictEqual(deleteCalls, expectedUrls, "Unexpected API delete call set.");
    assert.strictEqual(result.deleted, 4, "Expected four successful deletes.");
    assert.strictEqual(result.failed, 0, "Expected zero failed deletes.");
    assert.strictEqual(result.results.length, 4, "Expected four API delete results.");
    assert.deepStrictEqual(
      result.results.map((item) => item.category),
      ["tags", "customFields", "customValues", "triggerLinks"],
      "Unexpected category routing."
    );
    assert.ok(
      result.results.every((item) => item.status === "deleted"),
      "All API delete results should succeed."
    );
    assert.strictEqual(readCalls.length, 4, "Every category should receive a fresh readback.");
    assert.ok(result.results.every((item) => item.verificationStatus === "verified"), "Every delete should verify.");

    console.log(
      `API_DELETE_REGRESSION_JSON:${JSON.stringify({
        apiDeletionRegressionPassed: true,
        apiDeletionRegressionType: "new_regression_test",
        deleteCalls,
        readCalls,
        deleted: result.deleted,
        failed: result.failed,
        verificationFailed: result.verificationFailed,
      })}`
    );
  } finally {
    axios.create = originalCreate;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
