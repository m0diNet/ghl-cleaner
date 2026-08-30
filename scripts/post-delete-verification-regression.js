const assert = require("assert");
const axios = require("axios");

const { deleteSelectedApiItems, isResourceGoneError, verifyDeletedItems } = require("../web/services/ghlApi");

function apiError(status, message) {
  const error = new Error(message);
  error.response = { status, data: { message } };
  return error;
}

async function verifyWith(error, category = "tags") {
  const result = { category, id: "item-1", name: "Item", status: "deleted" };
  const client = {
    get: async () => {
      if (error) throw error;
      return { status: 200, data: { id: "item-1" } };
    },
  };
  const summary = await verifyDeletedItems({ client, locationId: "location-1", results: [result] });
  return { result, summary };
}

async function main() {
  const originalCreate = axios.create;
  axios.create = () => ({
    delete: async () => ({ status: 204, data: {} }),
    get: async () => { throw apiError(400, "Tag id is invalid."); },
  });
  const fullDelete = await deleteSelectedApiItems({
    locationId: "location-1",
    token: "fake-token",
    selections: { tags: [{ id: "tag-1", name: "Deleted tag" }] },
  });
  axios.create = originalCreate;
  assert.strictEqual(fullDelete.deleted, 1);
  assert.strictEqual(fullDelete.failed, 0);
  assert.strictEqual(fullDelete.verificationFailed, 0);

  axios.create = () => ({
    delete: async () => ({ status: 204, data: {} }),
    get: async () => { throw apiError(400, "The custom field id or field_key is invalid."); },
  });
  const fullCustomFieldDelete = await deleteSelectedApiItems({
    locationId: "location-1",
    token: "fake-token",
    selections: { customFields: [{ id: "field-1", name: "Deleted field" }] },
  });
  axios.create = originalCreate;
  assert.strictEqual(fullCustomFieldDelete.deleted, 1);
  assert.strictEqual(fullCustomFieldDelete.failed, 0);
  assert.strictEqual(fullCustomFieldDelete.verificationFailed, 0);

  const gone404 = await verifyWith(apiError(404, "Not found"));
  assert.strictEqual(gone404.result.verificationStatus, "verified");
  assert.strictEqual(gone404.summary.verificationFailed, 0);

  const invalidTagId = await verifyWith(apiError(400, "Tag id is invalid."));
  assert.strictEqual(invalidTagId.result.verificationStatus, "verified");
  assert.strictEqual(invalidTagId.summary.verificationFailed, 0);

  const customField404 = await verifyWith(apiError(404, "Not found"), "customFields");
  assert.strictEqual(customField404.result.verificationStatus, "verified");
  assert.strictEqual(customField404.summary.verificationFailed, 0);

  const invalidCustomFieldId = await verifyWith(
    apiError(400, "The custom field id or field_key is invalid."),
    "customFields"
  );
  assert.strictEqual(invalidCustomFieldId.result.verificationStatus, "verified");
  assert.strictEqual(invalidCustomFieldId.summary.verificationFailed, 0);

  const stillPresent = await verifyWith(null);
  assert.strictEqual(stillPresent.result.verificationStatus, "failed");
  assert.strictEqual(stillPresent.result.status, "verification_failed");
  assert.strictEqual(stillPresent.summary.verificationFailed, 1);

  for (const status of [401, 403, 429, 500, 503]) {
    const failed = await verifyWith(apiError(status, "Request failed"));
    assert.strictEqual(failed.result.verificationStatus, "failed", `${status} must fail verification`);
    assert.strictEqual(failed.summary.verificationFailed, 1, `${status} must increment verification failures`);
  }

  assert.strictEqual(isResourceGoneError(apiError(400, "Custom field id is invalid."), "customFields"), true);
  assert.strictEqual(isResourceGoneError(apiError(400, "The custom field id or field_key is invalid."), "customFields"), true);
  assert.strictEqual(isResourceGoneError(apiError(400, "Custom value id is invalid."), "customValues"), true);
  assert.strictEqual(isResourceGoneError(apiError(400, "Trigger link id is invalid."), "triggerLinks"), true);
  assert.strictEqual(isResourceGoneError(apiError(401, "Tag id is invalid."), "tags"), false);

  console.log(`POST_DELETE_VERIFICATION_REGRESSION_JSON:${JSON.stringify({
    postDeleteVerificationRegressionPassed: true,
    gone404Verified: true,
    invalidTagIdVerified: true,
    customField404Verified: true,
    invalidCustomFieldIdVerified: true,
    stillPresentFailed: true,
    authPermissionRateLimitAndServerErrorsFailed: true,
    summary: { deleted: fullCustomFieldDelete.deleted, failed: fullCustomFieldDelete.failed, verificationFailed: fullCustomFieldDelete.verificationFailed, skipped: 0 },
  })}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
