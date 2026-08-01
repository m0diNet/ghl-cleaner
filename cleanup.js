require("dotenv").config();
const ghl = require("./ghl");

const LOCATION_ID = process.env.GHL_LOCATION_ID;
const DRY_RUN = String(process.env.DRY_RUN).toLowerCase() !== "false";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function safeGet(name, url, options = {}) {
  try {
    const response = await ghl.get(url, options);
    return response.data;
  } catch (error) {
    console.log(`❌ READ FAILED: ${name}`);

    if (error.response) {
      console.log(`   Status: ${error.response.status}`);
      console.log(
        `   Message: ${JSON.stringify(error.response.data)}`
      );
    } else {
      console.log(`   Error: ${error.message}`);
    }

    return null;
  }
}

async function safeDelete(name, url) {
  if (DRY_RUN) {
    console.log(`🟡 WOULD DELETE: ${name}`);
    return true;
  }

  try {
    await ghl.delete(url);

    console.log(`✅ DELETED: ${name}`);

    // Small pause to avoid hammering the API.
    await sleep(150);

    return true;
  } catch (error) {
    console.log(`❌ FAILED: ${name}`);

    if (error.response) {
      console.log(`   Status: ${error.response.status}`);
      console.log(
        `   Message: ${JSON.stringify(error.response.data)}`
      );
    } else {
      console.log(`   Error: ${error.message}`);
    }

    return false;
  }
}

async function deleteList(title, items, getName, getUrl) {
  console.log("\n=================================");
  console.log(title);
  console.log("=================================");

  if (!items.length) {
    console.log("Nothing found.");
    return {
      found: 0,
      success: 0,
      failed: 0
    };
  }

  let success = 0;
  let failed = 0;

  for (const item of items) {
    const name = getName(item);
    const url = getUrl(item);

    if (!url) {
      console.log(`⚠️ SKIPPED: ${name} - Missing ID`);
      failed++;
      continue;
    }

    const result = await safeDelete(name, url);

    if (result) {
      success++;
    } else {
      failed++;
    }
  }

  return {
    found: items.length,
    success,
    failed
  };
}

async function getAllContacts() {
  const contacts = [];

  let startAfterId = null;
  let safety = 0;

  while (safety < 1000) {
    safety++;

    const params = {
      locationId: LOCATION_ID,
      limit: 100
    };

    if (startAfterId) {
      params.startAfterId = startAfterId;
    }

    const data = await safeGet(
      "Contacts",
      "/contacts/",
      { params }
    );

    const batch = data?.contacts || [];

    if (!batch.length) {
      break;
    }

    contacts.push(...batch);

    if (batch.length < 100) {
      break;
    }

    startAfterId = batch[batch.length - 1]?.id;

    if (!startAfterId) {
      break;
    }
  }

  return contacts;
}

async function run() {
  console.log("\n=================================");
  console.log("GHL MASTER CLEANUP TOOL");
  console.log("=================================");
  console.log(`Location ID: ${LOCATION_ID}`);
  console.log(
    `MODE: ${DRY_RUN ? "DRY RUN - NOTHING WILL DELETE" : "REAL DELETE"}`
  );
  console.log("=================================");

  const summary = {};

  // --------------------------------
  // 1. TAGS
  // --------------------------------

  const tagsData = await safeGet(
    "Tags",
    `/locations/${LOCATION_ID}/tags`
  );

  const tags = tagsData?.tags || [];

  summary.tags = await deleteList(
    "TAGS",
    tags,
    (item) => item.name || item.id || "Unnamed Tag",
    (item) =>
      item.id
        ? `/locations/${LOCATION_ID}/tags/${item.id}`
        : null
  );

  // --------------------------------
  // 2. CUSTOM FIELDS
  // --------------------------------

  const fieldsData = await safeGet(
    "Custom Fields",
    `/locations/${LOCATION_ID}/customFields`
  );

  const customFields = fieldsData?.customFields || [];

  summary.customFields = await deleteList(
    "CUSTOM FIELDS",
    customFields,
    (item) =>
      item.name ||
      item.fieldKey ||
      item.id ||
      "Unnamed Custom Field",
    (item) =>
      item.id
        ? `/locations/${LOCATION_ID}/customFields/${item.id}`
        : null
  );

  // --------------------------------
  // 3. CUSTOM VALUES
  // --------------------------------

  const valuesData = await safeGet(
    "Custom Values",
    `/locations/${LOCATION_ID}/customValues`
  );

  const customValues =
    valuesData?.customValues ||
    valuesData?.data ||
    [];

  summary.customValues = await deleteList(
    "CUSTOM VALUES",
    customValues,
    (item) =>
      item.name ||
      item.key ||
      item.id ||
      "Unnamed Custom Value",
    (item) =>
      item.id
        ? `/locations/${LOCATION_ID}/customValues/${item.id}`
        : null
  );

  // --------------------------------
  // 4. TRIGGER LINKS
  // --------------------------------

  const linksData = await safeGet(
    "Trigger Links",
    "/links/search",
    {
      params: {
        locationId: LOCATION_ID
      }
    }
  );

  const triggerLinks =
    linksData?.links ||
    linksData?.data ||
    [];

  summary.triggerLinks = await deleteList(
    "TRIGGER LINKS",
    triggerLinks,
    (item) =>
      item.name ||
      item.title ||
      item.id ||
      "Unnamed Trigger Link",
    (item) =>
      item.id
        ? `/links/${item.id}`
        : null
  );

  // --------------------------------
  // 5. CONTACTS
  // --------------------------------

  const contacts = await getAllContacts();

  summary.contacts = await deleteList(
    "CONTACTS",
    contacts,
    (item) =>
      item.name ||
      item.contactName ||
      item.email ||
      item.phone ||
      item.id ||
      "Unnamed Contact",
    (item) =>
      item.id
        ? `/contacts/${item.id}`
        : null
  );

  // --------------------------------
  // READ-ONLY / UNSUPPORTED AREAS
  // --------------------------------

  console.log("\n=================================");
  console.log("READ-ONLY / NOT AUTO-DELETED");
  console.log("=================================");

  const workflowsData = await safeGet(
    "Workflows",
    "/workflows/",
    {
      params: {
        locationId: LOCATION_ID
      }
    }
  );

  const workflows = workflowsData?.workflows || [];

  console.log(
    `⚠️ Workflows found: ${workflows.length}`
  );

  console.log(
    "   Not deleted because we have not confirmed a supported public delete endpoint."
  );

  const funnelsData = await safeGet(
    "Funnels",
    "/funnels/funnel/list",
    {
      params: {
        locationId: LOCATION_ID
      }
    }
  );

  const funnels =
    funnelsData?.funnels ||
    funnelsData?.data ||
    [];

  console.log(
    `⚠️ Funnels found: ${funnels.length}`
  );

  console.log(
    "   Not deleted because we have not confirmed a supported public delete endpoint."
  );

  const formsData = await safeGet(
    "Forms",
    "/forms/",
    {
      params: {
        locationId: LOCATION_ID
      }
    }
  );

  const forms =
    formsData?.forms ||
    formsData?.data ||
    [];

  console.log(
    `⚠️ Forms found: ${forms.length}`
  );

  console.log(
    "   Not deleted in this version until we confirm the correct supported delete operation."
  );

  // --------------------------------
  // FINAL SUMMARY
  // --------------------------------

  console.log("\n=================================");
  console.log("FINAL SUMMARY");
  console.log("=================================");

  for (const [key, result] of Object.entries(summary)) {
    console.log(
      `${key}: Found ${result.found} | ${
        DRY_RUN ? "Would delete" : "Deleted"
      } ${result.success} | Failed/Skipped ${result.failed}`
    );
  }

  console.log("");
  console.log(`Workflows remaining: ${workflows.length}`);
  console.log(`Funnels remaining: ${funnels.length}`);
  console.log(`Forms remaining: ${forms.length}`);

  console.log("\n=================================");

  if (DRY_RUN) {
    console.log("DRY RUN FINISHED");
    console.log("NOTHING WAS DELETED");
  } else {
    console.log("CLEANUP FINISHED");
    console.log("RUN node audit.js TO VERIFY");
  }

  console.log("=================================\n");
}

run().catch((error) => {
  console.error("FATAL ERROR:");
  console.error(error);

  process.exitCode = 1;
});