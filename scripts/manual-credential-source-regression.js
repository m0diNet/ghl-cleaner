const assert = require("assert");
const axios = require("axios");

async function main() {
  const previousToken = process.env.GHL_TOKEN;
  const previousLocation = process.env.GHL_LOCATION_ID;
  const originalCreate = axios.create;
  const calls = [];

  process.env.GHL_TOKEN = "env-token-a";
  process.env.GHL_LOCATION_ID = "env-location-a";

  axios.create = (config) => {
    assert.strictEqual(config.headers.Authorization, "Bearer pit-manual-b", "Manual PIT must be authoritative.");
    calls.push({ authUsed: config.headers.Authorization === "Bearer manual-token-b" });
    return {
      get: async (url) => {
        calls.push({ method: "GET", url });
        return { status: 200, data: { id: "manual-location-b", name: "Manual Location" } };
      },
      delete: async (url) => {
        calls.push({ method: "DELETE", url });
        return { status: 204, data: {} };
      },
    };
  };

  try {
    const { validateLocationAccess } = require("../web/services/ghlConnection");
    const { deleteSelectedApiItems } = require("../web/services/ghlApi");

    const location = await validateLocationAccess("pit-manual-b", "manual-location-b");
    assert.strictEqual(location.id, "manual-location-b");
    assert.ok(calls.some((call) => call.method === "GET" && call.url === "/locations/manual-location-b"));

    await deleteSelectedApiItems({
      token: "pit-manual-b",
      locationId: "manual-location-b",
      selections: { tags: [{ id: "tag-b", name: "Manual Tag" }] },
    });

    assert.ok(calls.some((call) => call.method === "DELETE" && call.url === "/locations/manual-location-b/tags/tag-b"));
    assert.ok(!calls.some((call) => JSON.stringify(call).includes("env-token-a")));
    assert.ok(!calls.some((call) => JSON.stringify(call).includes("env-location-a")));
    assert.ok(!calls.some((call) => JSON.stringify(call).includes("pit-manual-b")), "Regression must not print manual credentials.");

    const appSource = require("fs").readFileSync(require("path").join(__dirname, "..", "web", "public", "app.js"), "utf8");
    const serverSource = require("fs").readFileSync(require("path").join(__dirname, "..", "web", "server.js"), "utf8");
    assert.ok(appSource.includes("body: JSON.stringify({ token, locationId })"));
    assert.ok(!appSource.includes("That GHL token is invalid. Paste a valid Private Integration Token."));
    assert.ok(!appSource.includes("looksLikePrivateIntegrationToken(token)"));
    assert.ok(!appSource.includes("looksLikeLocationId(token)"));
    assert.ok(serverSource.includes("validateLocationAccess(token, locationId)"));
    assert.ok(serverSource.includes("request received: true"));
    assert.ok(serverSource.includes("tokenLength"));
    assert.ok(!serverSource.includes("isLikelyPrivateIntegrationToken(token)"));

    console.log(`MANUAL_CREDENTIAL_SOURCE_REGRESSION_JSON:${JSON.stringify({
      manualCredentialSourceRegressionPassed: true,
      envCredentialsIgnored: true,
      manualLocationVerified: true,
      deletePathUsedManualLocation: true,
      pitShapeAcceptedWithoutLocalRejection: true,
      serverValidationPathPresent: true,
    })}`);
  } finally {
    axios.create = originalCreate;
    if (previousToken === undefined) delete process.env.GHL_TOKEN;
    else process.env.GHL_TOKEN = previousToken;
    if (previousLocation === undefined) delete process.env.GHL_LOCATION_ID;
    else process.env.GHL_LOCATION_ID = previousLocation;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
