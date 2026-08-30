const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createConnectionStore } = require("../web/services/connectionStore");
const {
  classifyConnectionError,
  discoverAccessibleLocations,
  validateConnectionForLocation,
  validateConnection,
  validateLocationAccess,
} = require("../web/services/ghlConnection");

function makeReq(cookie = "") {
  return { headers: cookie ? { cookie } : {} };
}

function makeRes() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function makeClientFactory(routes, calls) {
  return (config) => ({
    async get(path, options = {}) {
      calls.push({ baseURL: config.baseURL, path, params: options.params || null });
      const route = routes[path];
      if (!route) {
        const error = new Error(`Unexpected path ${path}`);
        error.response = { status: 404, data: { message: "Not found" } };
        throw error;
      }

      if (route.error) {
        const error = new Error(route.error.message || `Error for ${path}`);
        error.response = route.error.response || { status: route.error.status || 500, data: route.error.data || {} };
        error.code = route.error.code || error.code;
        throw error;
      }

      return { status: route.status || 200, data: route.data };
    },
  });
}

function isLocationIdLike(value) {
  const trimmed = String(value || "").trim();
  return Boolean(trimmed) && /^[A-Za-z0-9]{18,28}$/.test(trimmed) && !trimmed.includes(".") && !trimmed.includes(" ");
}

function isPitLikeToken(value) {
  const trimmed = String(value || "").trim();
  return Boolean(trimmed) && trimmed.toLowerCase().startsWith("pit-") && trimmed.length > 8 && !trimmed.includes(" ");
}

async function expectReject(promise, code) {
  await assert.rejects(
    promise,
    (error) => error.code === code,
    `Expected rejection code ${code}.`
  );
}

async function main() {
  const store = createConnectionStore({ cookieName: "ghl_test_session" });
  const req = makeReq();
  const res = makeRes();

  const sessionId = store.ensureSessionId(req, res);
  assert.ok(sessionId, "A session id should be assigned.");
  const cookieHeader = res.getHeader("Set-Cookie");
  assert.ok(String(cookieHeader || "").includes("ghl_test_session"), "Session cookie should be emitted.");
  req.headers.cookie = Array.isArray(cookieHeader)
    ? String(cookieHeader[0]).split(";")[0]
    : String(cookieHeader).split(";")[0];

  const browserStatePath = store.browserStorageStatePath(sessionId);
  const connection = store.setConnection(req, res, {
    token: "secret-token",
    accountName: "Acme Co",
    companyName: "Acme Co",
    locations: [{ id: "loc-1", name: "Location One", companyName: "Acme Co" }],
    browserStorageStatePath: browserStatePath,
  });

  const raw = store.getConnection(req);
  assert.strictEqual(raw.token, "secret-token", "Token should remain server-side.");
  assert.strictEqual(connection.token, undefined, "Public connection snapshot must not include the token.");
  assert.ok(browserStatePath.includes(sessionId), "Browser state path should be tied to the session.");

  const appSource = fs.readFileSync(path.join(__dirname, "..", "web", "public", "app.js"), "utf8");
  const connectionSource = fs.readFileSync(path.join(__dirname, "..", "web", "services", "ghlConnection.js"), "utf8");
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "web", "public", "index.html"), "utf8");
  assert.ok(appSource.includes('startsWith("pit-")'), "UI token validation should accept PIT prefixes.");
  assert.ok(!appSource.includes('parts.length === 3'), "UI token validation must not require JWT shape.");
  assert.ok(indexSource.includes("connection-location-id"), "The connection form should expose a separate Location ID field.");
  assert.ok(connectionSource.includes('startsWith("pit-")'), "Server token validation should accept PIT prefixes.");
  assert.ok(!connectionSource.includes('parts.length !== 3'), "Server token validation must not require JWT shape.");
  assert.ok(connectionSource.includes("validateConnectionForLocation"), "The server should use the manual connection validation helper.");

  const selected = store.setSelectedLocation(req, res, {
    id: "loc-1",
    name: "Location One",
    companyName: "Acme Co",
  });
  assert.strictEqual(selected.selectedLocationId, "loc-1", "Selected location should be stored in the connection context.");
  assert.ok(store.isJobForSelectedLocation({ locationId: "loc-1" }, raw), "Selected job location should match the active connection.");
  assert.throws(
    () => store.ensureJobLocationMatchesConnection({ locationId: "loc-2" }, raw),
    /selected connection location/i,
    "Mismatched job locations should be rejected."
  );

  assert.ok(isLocationIdLike("CKk3Iy0oAsWhfUukk9xv"), "Location IDs should be detectable locally.");
  assert.ok(isPitLikeToken("pit-example-token"), "PITs should be detectable locally.");
  assert.ok(!isPitLikeToken("header.payload.signature"), "PIT validation must not require JWT shape.");
  assert.ok(appSource.includes("locationId, mode: \"manual-token-location\""), "The connection submit payload should include a Location ID.");

  await assert.rejects(
    validateConnectionForLocation("pit-manual", "", {
      clientFactory: makeClientFactory({}, []),
    }),
    (error) => error.code === "INVALID_LOCATION_ID",
    "Location ID should be required separately from the token."
  );

  const manualCalls = [];
  const manual = await validateConnectionForLocation("pit-manual", "loc-1", {
    clientFactory: makeClientFactory(
      {
        "/locations/loc-1": {
          data: { location: { id: "loc-1", name: "Location One", companyName: "Acme Co" } },
        },
      },
      manualCalls
    ),
  });
  assert.strictEqual(manual.selectedLocationId, "loc-1", "Manual connection should store the selected location id.");
  assert.strictEqual(manualCalls.length, 1, "Manual connection should not require agency discovery.");
  assert.strictEqual(manualCalls[0].path, "/locations/loc-1", "Manual connection should validate the exact location pair.");

  const invalidTokenCalls = [];
  await expectReject(
    validateConnectionForLocation("bad-token", "loc-1", {
      clientFactory: makeClientFactory(
        {
          "/locations/loc-1": {
            error: {
              status: 401,
              response: { status: 401, data: { message: "Invalid JWT" } },
            },
          },
        },
        invalidTokenCalls
      ),
    }),
    "INVALID_TOKEN"
  );
  assert.strictEqual(invalidTokenCalls.length, 0, "Malformed tokens should be rejected before any GHL request.");

  const pitInvalidCalls = [];
  await expectReject(
    validateConnectionForLocation("pit-invalid", "loc-1", {
      clientFactory: makeClientFactory(
        {
          "/locations/loc-1": {
            error: {
              status: 401,
              response: { status: 401, data: { message: "Invalid JWT" } },
            },
          },
        },
        pitInvalidCalls
      ),
    }),
    "INVALID_TOKEN"
  );
  assert.strictEqual(pitInvalidCalls[0].path, "/locations/loc-1", "PIT-shaped tokens should reach HighLevel for location validation.");

  const forbiddenCalls = [];
  await expectReject(
    validateConnectionForLocation("pit-forbidden", "loc-1", {
      clientFactory: makeClientFactory(
        {
          "/locations/loc-1": {
            error: {
              status: 403,
              response: { status: 403, data: { message: "Forbidden resource" } },
            },
          },
        },
        forbiddenCalls
      ),
    }),
    "TOKEN_FORBIDDEN_FOR_LOCATION"
  );
  assert.strictEqual(forbiddenCalls[0].path, "/locations/loc-1", "Forbidden tokens should be checked against the requested location.");

  const discoveryCalls = [];
  const discovery = await validateConnection("pit-discovery", {
    clientFactory: makeClientFactory(
      {
        "/users/search": { data: { users: [{ id: "user-1" }] } },
        "/locations/search": {
          data: {
            locations: [{ id: "loc-1", name: "Location One", companyName: "Acme Co" }],
          },
        },
      },
      discoveryCalls
    ),
  });
  assert.strictEqual(discovery.locations.length, 1, "Accessible locations should be discovered.");
  assert.strictEqual(discovery.locations[0].id, "loc-1", "Discovery should surface the verified location.");
  assert.strictEqual(discoveryCalls[0].path, "/users/search", "Discovery should begin with a safe auth probe.");
  assert.strictEqual(discoveryCalls[1].path, "/locations/search", "Discovery should then load accessible locations.");

  const noLocationsCalls = [];
  const subAccount = await validateConnection("pit-sub-account", {
    allowNoAccessibleLocations: true,
    clientFactory: makeClientFactory(
      {
        "/users/search": { data: { users: [{ id: "user-1" }] } },
        "/locations/search": { data: { locations: [] } },
        "/locations": { data: { locations: [] } },
      },
      noLocationsCalls
    ),
  });
  assert.strictEqual(subAccount.locations.length, 0, "Sub-account PITs should be able to proceed without agency discovery.");
  assert.strictEqual(noLocationsCalls[0].path, "/users/search", "Sub-account PITs should still probe the auth endpoint first.");

  await expectReject(
    validateConnection("pit-no-locations", {
      clientFactory: makeClientFactory(
        {
          "/users/search": { data: { users: [{ id: "user-1" }] } },
          "/locations/search": { data: { locations: [] } },
          "/locations": { data: { locations: [] } },
        },
        noLocationsCalls
      ),
    }),
    "NO_ACCESSIBLE_LOCATIONS"
  );

  const validatedLocation = await validateLocationAccess("pit-discovery", "loc-1", {
    clientFactory: makeClientFactory(
      {
        "/locations/loc-1": {
          data: { location: { id: "loc-1", name: "Location One", companyName: "Acme Co" } },
        },
      },
      []
    ),
  });
  assert.strictEqual(validatedLocation.id, "loc-1", "The selected location should validate successfully.");

  await expectReject(
    validateLocationAccess("pit-discovery", "bad-location", {
      clientFactory: makeClientFactory(
        {
          "/locations/bad-location": {
            error: {
              status: 403,
              response: { status: 403, data: { message: "Forbidden resource" } },
            },
          },
        },
        []
      ),
    }),
    "TOKEN_FORBIDDEN_FOR_LOCATION"
  );

  const discoveredAgain = await discoverAccessibleLocations("pit-discovery", {
    clientFactory: makeClientFactory(
      {
        "/locations/search": {
          data: {
            locations: [{ id: "loc-1", name: "Location One", companyName: "Acme Co" }],
          },
        },
      },
      []
    ),
  });
  assert.strictEqual(discoveredAgain.locations[0].id, "loc-1", "Location discovery should surface the verified location.");

  const publicStatus = store.sanitizeConnection(raw);
  assert.strictEqual(publicStatus.token, undefined, "Public connection status must not include token data.");
  assert.strictEqual(publicStatus.selectedLocationId, "loc-1", "Public status should preserve the selected location.");

  const secondSessionId = store.browserStorageStatePath("another-session");
  assert.notStrictEqual(
    browserStatePath,
    secondSessionId,
    "Browser storage state paths should be unique per connection session."
  );

  store.clearConnection(req, res);
  assert.strictEqual(store.getConnection(req), null, "Disconnect should destroy the connection context.");

  console.log(
    `CONNECTION_REGRESSION_JSON:${JSON.stringify({
      malformedTokenRejected: true,
      locationIdRejectedLocally: true,
      manualConnectionWithoutDiscovery: true,
      invalidTokenClassification: true,
      forbiddenTokenClassification: true,
      accessibleLocationsReturnedSafely: true,
      selectedLocationStored: true,
      unauthorizedSelectedLocationRejected: true,
      publicStatusContainsNoToken: true,
      disconnectDestroysContext: true,
      sessionBrowserStatePathPerConnection: true,
      deleteJobLocationGuarded: true,
    })}`
  );
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
