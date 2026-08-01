require("dotenv").config();
const ghl = require("./ghl");

const LOCATION_ID = process.env.GHL_LOCATION_ID;

async function safeGet(name, url, options = {}) {
  try {
    const response = await ghl.get(url, options);

    console.log(`✅ ${name}: SUCCESS`);

    return response.data;
  } catch (error) {
    console.log(`❌ ${name}: FAILED`);

    if (error.response) {
      console.log(`   Status: ${error.response.status}`);

      if (error.response.status === 401) {
        console.log("   Reason: Token/permission problem");
      }

      if (error.response.status === 403) {
        console.log("   Reason: Missing Private Integration scope");
      }
    } else {
      console.log(`   Reason: ${error.message}`);
    }

    return null;
  }
}

async function audit() {
  console.log("\n==============================");
  console.log("GHL SUBACCOUNT AUDIT");
  console.log("==============================");
  console.log(`Location ID: ${LOCATION_ID}`);
  console.log("MODE: READ ONLY - NOTHING WILL BE DELETED");
  console.log("==============================\n");

  // 1. Location
  const location = await safeGet(
    "Location",
    `/locations/${LOCATION_ID}`
  );

  if (location?.location) {
    console.log(`   Name: ${location.location.name}\n`);
  }

  // 2. Tags
  const tags = await safeGet(
    "Tags",
    `/locations/${LOCATION_ID}/tags`
  );

  console.log(
    `   Found: ${tags?.tags?.length ?? "Unknown"}\n`
  );

  // 3. Custom Fields
  const customFields = await safeGet(
    "Custom Fields",
    `/locations/${LOCATION_ID}/customFields`
  );

  console.log(
    `   Found: ${customFields?.customFields?.length ?? "Unknown"}\n`
  );
  // 4. Contacts
  const contacts = await safeGet(
    "Contacts",
    `/contacts/`,
    {
      params: {
        locationId: LOCATION_ID,
        limit: 100
      }
    }
  );

  console.log(
    `   Found on first page: ${contacts?.contacts?.length ?? "Unknown"}\n`
  );

  // 5. Opportunities
  const opportunities = await safeGet(
    "Opportunities",
    `/opportunities/search`,
    {
      params: {
        location_id: LOCATION_ID,
        limit: 100
      }
    }
  );

  console.log(
    `   Found on first page: ${opportunities?.opportunities?.length ?? "Unknown"}\n`
  );

  // 6. Calendars
  const calendars = await safeGet(
    "Calendars",
    `/calendars/`,
    {
      params: {
        locationId: LOCATION_ID
      }
    }
  );

  console.log(
    `   Found: ${calendars?.calendars?.length ?? "Unknown"}\n`
  );

    // 7. Workflows
  const workflows = await safeGet(
    "Workflows",
    `/workflows/`,
    {
      params: {
        locationId: LOCATION_ID
      }
    }
  );

  console.log(
    `   Found: ${workflows?.workflows?.length ?? "Unknown"}`
  );

  if (workflows?.workflows?.length) {
    console.log("\n   WORKFLOW LIST:");

    workflows.workflows.forEach((workflow, index) => {
      console.log(
        `   ${index + 1}. ${workflow.name || "Unnamed Workflow"}`
      );
    });
  }

  console.log("");

    // 8. Funnels
  const funnels = await safeGet(
    "Funnels",
    `/funnels/funnel/list`,
    {
      params: {
        locationId: LOCATION_ID
      }
    }
  );

  const funnelList =
    funnels?.funnels ||
    funnels?.data ||
    [];

  console.log(
    `   Found: ${funnelList.length}`
  );

  if (funnelList.length) {
    console.log("\n   FUNNEL LIST:");

    funnelList.forEach((funnel, index) => {
      console.log(
        `   ${index + 1}. ${funnel.name || funnel.title || "Unnamed Funnel"}`
      );
    });
  }
  // 9. Pipelines
  const pipelines = await safeGet(
    "Pipelines",
    `/opportunities/pipelines`,
    {
      params: {
        locationId: LOCATION_ID
      }
    }
  );

  console.log(
    `   Found: ${pipelines?.pipelines?.length ?? "Unknown"}`
  );

  if (pipelines?.pipelines?.length) {
    console.log("\n   PIPELINE LIST:");

    pipelines.pipelines.forEach((pipeline, index) => {
      console.log(
        `   ${index + 1}. ${pipeline.name || "Unnamed Pipeline"}`
      );
    });
  }

  console.log("");


  // 10. Forms
  const forms = await safeGet(
    "Forms",
    `/forms/`,
    {
      params: {
        locationId: LOCATION_ID
      }
    }
  );

  const formList =
    forms?.forms ||
    forms?.data ||
    [];

  console.log(
    `   Found: ${formList.length}`
  );

  if (formList.length) {
    console.log("\n   FORM LIST:");

    formList.forEach((form, index) => {
      console.log(
        `   ${index + 1}. ${form.name || form.title || "Unnamed Form"}`
      );
    });
  }

  console.log("");


  // 11. Surveys
  const surveys = await safeGet(
    "Surveys",
    `/surveys/`,
    {
      params: {
        locationId: LOCATION_ID
      }
    }
  );

  const surveyList =
    surveys?.surveys ||
    surveys?.data ||
    [];

  console.log(
    `   Found: ${surveyList.length}`
  );

  if (surveyList.length) {
    console.log("\n   SURVEY LIST:");

    surveyList.forEach((survey, index) => {
      console.log(
        `   ${index + 1}. ${survey.name || survey.title || "Unnamed Survey"}`
      );
    });
  }

  console.log("");


  // 12. URL Redirects
  const redirects = await safeGet(
    "URL Redirects",
    `/funnels/lookup/redirect/list`,
    {
      params: {
        locationId: LOCATION_ID
      }
    }
  );

  const redirectList =
    redirects?.redirects ||
    redirects?.data ||
    [];

  console.log(
    `   Found: ${redirectList.length}`
  );

  if (redirectList.length) {
    console.log("\n   REDIRECT LIST:");

    redirectList.forEach((redirect, index) => {
      console.log(
        `   ${index + 1}. ${
          redirect.domain || redirect.path || redirect.url || "Unnamed Redirect"
        }`
      );
    });
  }
  // 13. Products
  const products = await safeGet(
    "Products",
    `/products/`,
    {
      params: {
        locationId: LOCATION_ID,
        limit: 100
      }
    }
  );

  const productList =
    products?.products ||
    products?.data ||
    [];

  console.log(
    `   Found on first page: ${productList.length}`
  );

  if (productList.length) {
    console.log("\n   PRODUCT LIST:");

    productList.forEach((product, index) => {
      console.log(
        `   ${index + 1}. ${product.name || "Unnamed Product"}`
      );
    });
  }
  // 14. Custom Values
  const customValues = await safeGet(
    "Custom Values",
    `/locations/${LOCATION_ID}/customValues`
  );

  const customValueList =
    customValues?.customValues ||
    customValues?.data ||
    [];

  console.log(
    `   Found: ${customValueList.length}`
  );

  if (customValueList.length) {
    console.log("\n   CUSTOM VALUE LIST:");

    customValueList.forEach((item, index) => {
      console.log(
        `   ${index + 1}. ${item.name || item.key || "Unnamed Custom Value"}`
      );
    });
  }
  // 15. Email / SMS Templates
  const templates = await safeGet(
    "Email/SMS Templates",
    `/locations/${LOCATION_ID}/templates`
  );

  const templateList =
    templates?.templates ||
    templates?.data ||
    [];

  console.log(
    `   Found: ${templateList.length}`
  );

  if (templateList.length) {
    console.log("\n   TEMPLATE LIST:");

    templateList.forEach((template, index) => {
      console.log(
        `   ${index + 1}. ${
          template.name ||
          template.title ||
          "Unnamed Template"
        }`
      );
    });
  }
  // 16. Trigger Links
  const triggerLinks = await safeGet(
    "Trigger Links",
    `/links/search`,
    {
      params: {
        locationId: LOCATION_ID
      }
    }
  );

  const triggerLinkList =
    triggerLinks?.links ||
    triggerLinks?.data ||
    [];

  console.log(
    `   Found: ${triggerLinkList.length}`
  );

  if (triggerLinkList.length) {
    console.log("\n   TRIGGER LINK LIST:");

    triggerLinkList.forEach((link, index) => {
      console.log(
        `   ${index + 1}. ${
          link.name ||
          link.title ||
          link.url ||
          "Unnamed Trigger Link"
        }`
      );
    });
  }

  console.log("");
  console.log("");
  console.log("");
  console.log("");
  console.log("");
  console.log("");
    console.log("==============================");
  console.log("AUDIT FINISHED");
  console.log("NOTHING WAS DELETED");
  console.log("==============================\n");
}

audit();