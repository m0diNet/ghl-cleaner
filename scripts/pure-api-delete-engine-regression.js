const assert = require("assert");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

async function main() {
  const originalCreate = axios.create;
  const deleteCalls = [];
  const readCalls = [];
  let failedId = "";

  axios.create = () => ({
    delete: async (url) => {
      deleteCalls.push(url);
      if (url.endsWith("field-fails")) throw new Error("simulated API failure");
      return { status: 204, data: {} };
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
    const result = await deleteSelectedApiItems({
      locationId: "loc-1",
      token: "token",
      selections: {
        tags: [{ id: "tag-selected", name: "Selected" }],
        customFields: [{ id: "field-fails", name: "Fails" }],
        customValues: [{ id: "value-selected", name: "Value" }],
        triggerLinks: [{ id: "link-selected", name: "Link" }],
      },
    });

    assert.strictEqual(result.deleted, 3, "Unrelated successful deletes should continue after one failure.");
    assert.strictEqual(result.failed, 1, "The simulated API failure should be reported independently.");
    assert.strictEqual(result.verificationFailed, 0, "Fresh readback should verify successful deletes.");
    assert.strictEqual(deleteCalls.length, 4, "Only selected IDs should be sent to DELETE.");
    assert.strictEqual(readCalls.length, 4, "Every attempted category should receive readback.");
    assert.ok(result.results.some((item) => item.id === "field-fails" && item.status === "failed"));

    const server = fs.readFileSync(path.join(__dirname, "..", "web", "server.js"), "utf8");
    const app = fs.readFileSync(path.join(__dirname, "..", "web", "public", "app.js"), "utf8");
    const scanner = fs.readFileSync(path.join(__dirname, "..", "web", "services", "verifiedScanner.js"), "utf8");
    const html = fs.readFileSync(path.join(__dirname, "..", "web", "public", "index.html"), "utf8");
    const serverSource = fs.readFileSync(path.join(__dirname, "..", "web", "server.js"), "utf8");
    const connectionApp = fs.readFileSync(path.join(__dirname, "..", "web", "public", "app.js"), "utf8");
    const supported = ["tags", "customFields", "customValues", "triggerLinks"];

    assert.ok(server.includes("Unsupported deletion category"), "Server must reject unsupported categories.");
    assert.ok(server.includes("The verified scan expired"), "Expired verified scans must block deletion.");
    assert.ok(server.includes("allowed.get(String(jobIdentity(item) || item.id || ''))"), "Selections must be rebuilt from the verified snapshot.");
    assert.ok(server.includes("normalizeDeleteJob(item, category, snapshot.locationId)"), "Client metadata must not replace snapshot truth.");
    assert.ok(!server.includes("BROWSER_WORKER_SCRIPTS"), "Browser deletion worker routing must be inactive.");
    assert.ok(!server.includes("/api/browserless-health"), "Browserless deletion health routes must be inactive.");
    assert.ok(!server.includes("browser(category"), "Server must not invoke Browserless deletion.");
    assert.deepStrictEqual(
      supported.filter((category) => app.includes(`\"${category}\"`)).sort(),
      [...supported].sort(),
      "Active UI should retain all four supported categories."
    );
    assert.ok(!app.includes("\"workflows\""), "Workflow category must not appear in active UI code.");
    assert.ok(!app.includes("\"funnels\""), "Funnel category must not appear in active UI code.");
    assert.ok(!app.includes("\"forms\""), "Form category must not appear in active UI code.");
    assert.ok(scanner.includes("const scanners ="), "Verified scanner must remain active.");
    assert.ok(!scanner.includes("workflows: scanWorkflows"), "Workflow scanner must not be active.");
    assert.ok(!scanner.includes("funnels: scanFunnels"), "Funnel scanner must not be active.");
    assert.ok(!scanner.includes("forms: scanForms"), "Form scanner must not be active.");
    assert.ok(html.includes('id="integration-token"') && html.includes('GHL Private Integration Token'), "PIT field must be visible.");
    assert.ok(html.includes('id="location-id"') && html.includes('Enter GHL Location ID'), "Location ID field must be visible.");
    assert.ok(html.includes('id="integration-token" type="password"') && html.includes('id="location-id" type="text"'), "Both connection fields must be required inputs.");
    assert.ok(connectionApp.includes('JSON.stringify({ token, locationId })'), "Connect must submit both PIT and Location ID.");
    assert.ok(serverSource.includes('const locationId = String(req.body.locationId || \'\').trim();'), "Server must read the supplied Location ID.");
    assert.ok(serverSource.includes('validateLocationAccess(token, locationId)'), "Server must verify access to the supplied Location ID.");
    assert.ok(!serverSource.includes("/api/connection/locations"), "Automatic location discovery route must be removed.");
    assert.ok(!serverSource.includes("/api/connection/select-location"), "Selected-location route must be removed.");
    assert.ok(!connectionApp.includes("refreshLocations"), "Refresh locations UI must be removed.");
    assert.ok(!connectionApp.includes("selectLocation(locationId)"), "Location picker UI must be removed.");
    assert.ok(!serverSource.includes("locations: discovered.locations"), "Connection must not store discovered locations.");
    assert.ok(!server.includes("/api/custom-values/import"), "Custom Value import routes must be removed.");
    assert.ok(!server.includes("/api/custom-values/ensure"), "Custom Value creation routes must be removed.");
    assert.ok(!html.includes("Custom Values Setup"), "Custom Value setup UI must be removed.");
    assert.ok(!html.includes("Upload CSV/XLSX"), "Custom Value file upload UI must be removed.");
    assert.ok(!html.includes("Apply custom values"), "Custom Value apply UI must be removed.");

    console.log(`PURE_API_DELETE_ENGINE_REGRESSION_JSON:${JSON.stringify({
      pureApiDeleteEngineRegressionPassed: true,
      supportedCategories: supported,
      deleted: result.deleted,
      failed: result.failed,
      verificationFailed: result.verificationFailed,
      browserlessDeletionRouteActive: false,
    })}`);
  } finally {
    axios.create = originalCreate;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
