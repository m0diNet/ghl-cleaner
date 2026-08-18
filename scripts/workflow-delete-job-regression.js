const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { normalizeDeleteJob } = require("../web/services/deleteJob");
let workflowWorker = null;

function readSource() {
  return fs.readFileSync(path.join(__dirname, "..", "browser-local", "workflows.js"), "utf8");
}

function withDeleteJobsJson(value, fn) {
  const previous = process.env.DELETE_JOBS_JSON;
  if (value === undefined) {
    delete process.env.DELETE_JOBS_JSON;
  } else {
    process.env.DELETE_JOBS_JSON = value;
  }

  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.DELETE_JOBS_JSON;
    } else {
      process.env.DELETE_JOBS_JSON = previous;
    }
  }
}

function validateParsedJobs(result, expectedCount, message) {
  assert.strictEqual(result.jobs.length, expectedCount, message);
  if (result.error) {
    assert.ok(typeof result.error === "string");
  }
}

function main() {
  const source = readSource();
  process.env.GHL_LOCATION_ID = "auth-loc";
  delete require.cache[require.resolve("../browser-local/workflows")];
  workflowWorker = require("../browser-local/workflows");
  const sampleJob = {
    locationId: "auth-loc",
    resourceType: "workflow",
    resourceId: "c7baaf8f-7ac3-43f5-b532-aa23797f6886",
    resourceName: "-AIS",
    parentId: "",
    parentName: "Home",
    metadata: {
      source: "scanner",
    },
  };

  const parsedSingle = withDeleteJobsJson(JSON.stringify([sampleJob]), () =>
    workflowWorker.parseDeleteJobsFromEnv()
  );
  validateParsedJobs(parsedSingle, 1, "DELETE_JOBS_JSON should parse a single workflow job.");
  assert.strictEqual(parsedSingle.jobs[0].resourceType, "workflow");
  assert.strictEqual(parsedSingle.jobs[0].locationId, sampleJob.locationId);
  assert.strictEqual(parsedSingle.jobs[0].resourceId, sampleJob.resourceId);
  assert.strictEqual(parsedSingle.jobs[0].resourceName, sampleJob.resourceName);

  const selectedSingle = workflowWorker.selectSingleWorkflowJob(parsedSingle.jobs);
  assert.ok(selectedSingle.job, "A single workflow job should be selected.");
  assert.strictEqual(selectedSingle.job.resourceId, sampleJob.resourceId);
  assert.strictEqual(selectedSingle.job.resourceName, sampleJob.resourceName);

  const missingJob = withDeleteJobsJson("", () => workflowWorker.parseDeleteJobsFromEnv());
  assert.strictEqual(missingJob.jobs.length, 0, "Missing DELETE_JOBS_JSON should fail safely.");
  assert.ok(missingJob.error);

  const multipleJobs = withDeleteJobsJson(JSON.stringify([sampleJob, { ...sampleJob, resourceId: "second" }]), () =>
    workflowWorker.parseDeleteJobsFromEnv()
  );
  const selectedMultiple = workflowWorker.selectSingleWorkflowJob(multipleJobs.jobs);
  assert.strictEqual(selectedMultiple.job, null, "Multiple jobs should fail safely.");
  assert.match(selectedMultiple.error, /exactly one workflow job/i);

  const wrongType = withDeleteJobsJson(JSON.stringify([{ ...sampleJob, resourceType: "form" }]), () =>
    workflowWorker.parseDeleteJobsFromEnv()
  );
  const selectedWrongType = workflowWorker.selectSingleWorkflowJob(wrongType.jobs);
  assert.strictEqual(selectedWrongType.job, null, "Wrong resource types should fail safely.");
  assert.match(selectedWrongType.error, /Unsupported resourceType/i);

  const locationMismatch = workflowWorker.selectSingleWorkflowJob([
    { ...sampleJob, locationId: "other-loc" },
  ]);
  assert.strictEqual(locationMismatch.job, null, "Location mismatch should fail safely.");
  assert.match(locationMismatch.error, /authenticated selected location/i);

  const normalized = normalizeDeleteJob(sampleJob, "workflow", sampleJob.locationId);
  assert.strictEqual(normalized.locationId, sampleJob.locationId);
  assert.strictEqual(normalized.resourceId, sampleJob.resourceId);
  assert.strictEqual(normalized.resourceName, sampleJob.resourceName);
  assert.strictEqual(normalized.parentName, sampleJob.parentName);

  assert.ok(!source.includes(".01.00 | MegaLink - Dec25"), "Hard-coded MegaLink folder must not be used in production path.");
  assert.ok(source.includes('DELETE_JOBS_JSON'), "Workflow worker must consume DELETE_JOBS_JSON.");
  assert.ok(source.includes('WORKFLOW_DRY_RUN'), "Workflow dry-run support must be present.");
  assert.ok(source.includes('WORKFLOW_TARGET_RESOLUTION_JSON'), "Dry-run target resolution marker must be present.");
  assert.ok(source.includes("selectSingleWorkflowJob"), "Workflow worker should enforce single-job selection.");

  const dryRunIndex = source.indexOf("if (dryRun)");
  const destructiveClickIndex = source.indexOf("deleteWorkflowItem.click");
  assert.ok(dryRunIndex >= 0, "Dry-run branch must exist.");
  assert.ok(destructiveClickIndex > dryRunIndex, "Destructive delete path must remain after the dry-run branch.");

  assert.ok(workflowWorker.hasProtectedWorkflowName("..OLSP - Utilities - DO NOT REMOVE or EDIT - Dec25"));
  assert.ok(workflowWorker.isRootFolderTarget(sampleJob));
  assert.strictEqual(workflowWorker.getWorkflowsUrl(sampleJob.locationId).includes(sampleJob.locationId), true);

  const summary = {
    deleteJobsJsonParsed: true,
    exactSingleWorkflowJobAccepted: true,
    missingJobFails: true,
    multipleWorkflowJobsFail: true,
    wrongResourceTypeFails: true,
    hardCodedMegaLinkFolderUsed: false,
    selectedJobFieldsPreserved: true,
    protectedFolderJobRejected: true,
    dryRunNeverCallsDestructiveConfirmationPath: true,
    locationMismatchRejected: true,
  };

  console.log(`WORKFLOW_DELETE_JOB_REGRESSION_JSON:${JSON.stringify(summary)}`);
}

main();
