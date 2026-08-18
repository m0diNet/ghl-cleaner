require("dotenv").config({ quiet: true });

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function resetEnv(previous) {
  if (previous.DELETE_JOBS_JSON === undefined) {
    delete process.env.DELETE_JOBS_JSON;
  } else {
    process.env.DELETE_JOBS_JSON = previous.DELETE_JOBS_JSON;
  }

  if (previous.ALLOW_TEST_DEFAULTS === undefined) {
    delete process.env.ALLOW_TEST_DEFAULTS;
  } else {
    process.env.ALLOW_TEST_DEFAULTS = previous.ALLOW_TEST_DEFAULTS;
  }

  if (previous.GHL_LOCATION_ID === undefined) {
    delete process.env.GHL_LOCATION_ID;
  } else {
    process.env.GHL_LOCATION_ID = previous.GHL_LOCATION_ID;
  }
}

async function main() {
  const previous = {
    DELETE_JOBS_JSON: process.env.DELETE_JOBS_JSON,
    ALLOW_TEST_DEFAULTS: process.env.ALLOW_TEST_DEFAULTS,
    GHL_LOCATION_ID: process.env.GHL_LOCATION_ID,
  };

  try {
    process.env.GHL_LOCATION_ID = "auth-loc";
    delete require.cache[require.resolve("../browser-local/forms")];
    const source = fs.readFileSync(path.join(__dirname, "..", "browser-local", "forms.js"), "utf8");
    assert.ok(!source.includes("Live Training | 01 | Tuesday - Dec25"), "Hard-coded form defaults must be removed.");
    assert.ok(!source.includes("..00.00 | Live Training - Dec25"), "Hard-coded folder defaults must be removed.");
    const {
      getFormsUrl,
      parseDeleteJobsJson,
      selectSingleFormJob,
    } = require("../browser-local/forms");

    const sourceJob = {
      locationId: "auth-loc",
      resourceType: "form",
      resourceId: "form-123",
      resourceName: "My Exact Form",
      parentId: "folder-456",
      parentName: "Parent Folder",
      metadata: {
        source: "scanner",
      },
      customField: "kept",
    };

    process.env.DELETE_JOBS_JSON = JSON.stringify([sourceJob]);
    const parsedJobs = parseDeleteJobsJson();
    assert.strictEqual(parsedJobs.length, 1, "Expected exactly one parsed form job.");
    assert.strictEqual(parsedJobs[0].locationId, "auth-loc", "locationId should be preserved.");
    assert.strictEqual(parsedJobs[0].resourceId, "form-123", "resourceId should be preserved.");
    assert.strictEqual(parsedJobs[0].resourceName, "My Exact Form", "resourceName should be preserved.");
    assert.strictEqual(parsedJobs[0].parentId, "folder-456", "parentId should be preserved.");
    assert.strictEqual(parsedJobs[0].parentName, "Parent Folder", "parentName should be preserved.");
    assert.strictEqual(parsedJobs[0].metadata.customField, "kept", "metadata should be preserved.");

    const selected = selectSingleFormJob(parsedJobs);
    assert.ok(selected.job, "A single form job should be selected.");
    assert.strictEqual(selected.job.resourceId, "form-123");
    assert.strictEqual(selected.job.resourceName, "My Exact Form");

    process.env.DELETE_JOBS_JSON = "";
    const normalFallback = parseDeleteJobsJson();
    assert.deepStrictEqual(normalFallback, [], "Normal mode must not auto-select test defaults.");

    const missingJob = selectSingleFormJob([]);
    assert.strictEqual(missingJob.job, null, "Missing job should fail safely.");
    assert.match(missingJob.error, /No form job was provided|Expected exactly one form job/i);

    const multiJob = selectSingleFormJob(
      [
        { locationId: "loc-1", resourceType: "form", resourceId: "one", resourceName: "One" },
        { locationId: "loc-1", resourceType: "form", resourceId: "two", resourceName: "Two" },
      ]
    );
    assert.strictEqual(multiJob.job, null, "Multiple jobs should fail safely.");
    assert.match(multiJob.error, /Expected exactly one form job/i);

    const unsupportedJob = selectSingleFormJob(
      [
        { locationId: "loc-1", resourceType: "formFolder", resourceId: "folder-1", resourceName: "Folder" },
      ]
    );
    assert.strictEqual(unsupportedJob.job, null, "Unsupported job types should fail safely.");
    assert.match(unsupportedJob.error, /Unsupported delete job type/i);

    const locationMismatch = selectSingleFormJob([
      {
        locationId: "other-loc",
        resourceType: "form",
        resourceId: "form-xyz",
        resourceName: "My Exact Form",
      },
    ]);
    assert.strictEqual(locationMismatch.job, null, "Location mismatch should fail safely.");
    assert.match(locationMismatch.error, /authenticated selected location/i);

    assert.ok(getFormsUrl("auth-loc").includes("/form-builder/main"));

    console.log(
      `FORM_DELETE_REGRESSION_JSON:${JSON.stringify({
        deleteJobsJsonParsed: true,
        normalFallbackBlocked: true,
        missingJobFailedSafely: true,
        multipleJobsFailedSafely: true,
        selectedJobFieldsPreserved: true,
        locationMismatchRejected: true,
        hardCodedDefaultsRemoved: true,
      })}`
    );
  } finally {
    resetEnv(previous);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
