const assert = require("assert");
const { classifyConnectionError } = require("../web/services/ghlConnection");

function errorFor(status, message, code) {
  return {
    response: {
      status,
      data: { message, code },
    },
  };
}

function assertMapping(status, expectedCode, expectedMessage) {
  const result = classifyConnectionError(errorFor(status, `mock-${status}`, `HL-${status}`), "location");
  assert.strictEqual(result.status, status);
  assert.strictEqual(result.code, expectedCode);
  assert.strictEqual(result.message, expectedMessage);
  assert.strictEqual(result.details, `mock-${status}`);
  assert.strictEqual(result.ghlErrorCode, `HL-${status}`);
}

assertMapping(401, "AUTHENTICATION_FAILED", "Authentication failed. Check your Private Integration Token.");
assertMapping(403, "LOCATION_ACCESS_FORBIDDEN", "The token does not have permission to access this location.");
assertMapping(404, "LOCATION_NOT_FOUND_OR_INACCESSIBLE", "Location not found or this token cannot access that Location ID.");
assertMapping(429, "RATE_LIMITED", "HighLevel rate limit reached. Try again shortly.");
assertMapping(503, "HIGHLEVEL_UNAVAILABLE", "Unable to reach HighLevel right now.");

const network = classifyConnectionError({ code: "ECONNRESET", message: "mock-network" }, "location");
assert.strictEqual(network.code, "HIGHLEVEL_UNAVAILABLE");
assert.strictEqual(network.message, "Unable to reach HighLevel right now.");

console.log(`CONNECTION_FAILURE_MAPPING_REGRESSION_JSON:${JSON.stringify({
  connectionFailureMappingRegressionPassed: true,
  mappedStatuses: [401, 403, 404, 429, 503],
  networkMapped: true,
})}`);
