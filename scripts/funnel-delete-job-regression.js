require("dotenv").config({ quiet: true });

const assert = require("assert");
const fs = require("fs");
const path = require("path");
let funnelWorker = null;

function main() {
  process.env.GHL_LOCATION_ID = "auth-loc";
  delete require.cache[require.resolve("../browser-v2/funnels")];
  funnelWorker = require("../browser-v2/funnels");
  const source = fs.readFileSync(path.join(__dirname, "..", "browser-v2", "funnels.js"), "utf8");

  assert.ok(!source.includes(`require("./common")`), "Funnel worker must not import ./common.");
  assert.ok(!source.includes("DEFAULT_FOLDER_NAME"), "Funnel worker must not use a hard-coded default folder.");
  assert.ok(!source.includes("DEFAULT_FUNNEL_NAME"), "Funnel worker must not use a hard-coded default funnel.");
  assert.ok(source.includes(`require("../services/browserless")`), "Funnel worker must use the canonical browserless helper.");
  assert.ok(source.includes("DELETE_JOBS_JSON"), "Funnel worker should read DELETE_JOBS_JSON.");
  assert.ok(source.includes("selectSingleFunnelJob"), "Funnel worker should enforce single-job selection.");
  assert.ok(source.includes("resourceId"), "Funnel worker should use normalized resourceId.");
  assert.ok(source.includes("resourceName"), "Funnel worker should use normalized resourceName.");

  const selected = funnelWorker.selectSingleFunnelJob([
    {
      locationId: "auth-loc",
      resourceType: "funnel",
      resourceId: "funnel-123",
      resourceName: "My Funnel",
      parentId: "folder-1",
      parentName: "Funnel Folder",
    },
  ]);
  assert.ok(selected.job, "A single funnel job should be selected.");
  assert.strictEqual(selected.job.resourceId, "funnel-123");
  assert.strictEqual(selected.job.resourceName, "My Funnel");

  const locationMismatch = funnelWorker.selectSingleFunnelJob([
    {
      locationId: "other-loc",
      resourceType: "funnel",
      resourceId: "funnel-123",
      resourceName: "My Funnel",
    },
  ]);
  assert.strictEqual(locationMismatch.job, null, "Location mismatch should fail safely.");
  assert.match(locationMismatch.error, /authenticated selected location/i);

  console.log(
    `FUNNEL_DELETE_JOB_REGRESSION_JSON:${JSON.stringify({
      funnelRegressionPassed: true,
      commonImportRemoved: true,
      hardCodedDefaultsRemoved: true,
      canonicalBrowserlessHelperUsed: true,
      deleteJobsJsonReferenced: true,
      singleJobSelectionEnforced: true,
      locationMismatchRejected: true,
    })}`
  );
}

main();
