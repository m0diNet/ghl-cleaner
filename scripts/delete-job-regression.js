const assert = require("assert");
const {
  jobIdentity,
  jobName,
  jobParentId,
  jobParentName,
  normalizeDeleteJob,
  normalizeDeleteJobs,
} = require("../web/services/deleteJob");

function main() {
  const source = {
    locationId: "loc-123",
    resourceType: "form",
    resourceId: "form-456",
    resourceName: "Form Name",
    parentId: "folder-789",
    parentName: "Folder Name",
    metadata: {
      source: "scanner",
    },
    extra: "kept",
  };

  const normalized = normalizeDeleteJob(source, "form", "loc-123");
  assert.strictEqual(normalized.locationId, "loc-123");
  assert.strictEqual(normalized.resourceType, "form");
  assert.strictEqual(normalized.resourceId, "form-456");
  assert.strictEqual(normalized.resourceName, "Form Name");
  assert.strictEqual(normalized.parentId, "folder-789");
  assert.strictEqual(normalized.parentName, "Folder Name");
  assert.strictEqual(normalized.metadata.source, "scanner");
  assert.strictEqual(normalized.metadata.extra, "kept");
  assert.strictEqual(jobIdentity(source), "form-456");
  assert.strictEqual(jobName(source), "Form Name");
  assert.strictEqual(jobParentId(source), "folder-789");
  assert.strictEqual(jobParentName(source), "Folder Name");

  const normalizedList = normalizeDeleteJobs([source, { ...source, resourceId: "second", resourceName: "Second" }], "form", "loc-123");
  assert.strictEqual(normalizedList.length, 2);

  console.log(
    `DELETE_JOB_REGRESSION_JSON:${JSON.stringify({
      genericJobContractPreserved: true,
      normalizedJobsPreserved: true,
    })}`
  );
}

main();
