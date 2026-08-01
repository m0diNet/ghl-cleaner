function normalizeKey(label) {
  const map = {
    Location: "location",
    Tags: "tags",
    "Custom Fields": "customFields",
    Contacts: "contacts",
    Opportunities: "opportunities",
    Calendars: "calendars",
    Workflows: "workflows",
    Funnels: "funnels",
    Pipelines: "pipelines",
    Forms: "forms",
    Surveys: "surveys",
    "URL Redirects": "urlRedirects",
    Products: "products",
    "Custom Values": "customValues",
    "Email/SMS Templates": "templates",
    "Trigger Links": "triggerLinks",
  };

  return map[label] || null;
}

function createResource(label) {
  return {
    label,
    count: 0,
    items: [],
    status: "unknown",
  };
}

function createEmptyResources() {
  return {
    tags: createResource("Tags"),
    customFields: createResource("Custom Fields"),
    customValues: createResource("Custom Values"),
    calendars: createResource("Calendars"),
    workflows: createResource("Workflows"),
    funnels: createResource("Funnels"),
    forms: createResource("Forms"),
    triggerLinks: createResource("Trigger Links"),
    contacts: createResource("Contacts"),
    opportunities: createResource("Opportunities"),
    pipelines: createResource("Pipelines"),
    surveys: createResource("Surveys"),
    products: createResource("Products"),
    templates: createResource("Email/SMS Templates"),
    urlRedirects: createResource("URL Redirects"),
  };
}

function makeItemId(category, position, name) {
  const safeName = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${category}-${position}-${safeName || "item"}`;
}

function parseAuditOutput(output) {
  const resources = createEmptyResources();

  const lines = String(output || "")
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\r/g, "")
    .split("\n");

  let locationName = "Connected GHL Account";
  let activeKey = null;
  let readingList = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();

    const successMatch = line.match(/^✅ (.+?): SUCCESS$/);
    const failedMatch = line.match(/^❌ (.+?): FAILED$/);

    if (successMatch || failedMatch) {
      const label = successMatch
        ? successMatch[1]
        : failedMatch[1];

      const key = normalizeKey(label);

      activeKey = key;
      readingList = false;

      if (key && resources[key]) {
        resources[key].status = successMatch
          ? "success"
          : "failed";
      }

      continue;
    }

    if (activeKey === "location") {
      const nameMatch = line.match(/^Name:\s*(.+)$/);

      if (nameMatch) {
        locationName = nameMatch[1].trim();
      }

      continue;
    }

    if (!activeKey || !resources[activeKey]) {
      continue;
    }

    const countMatch = line.match(
      /^Found(?: on first page)?:\s*(\d+)/
    );

    if (countMatch) {
      resources[activeKey].count = Number(countMatch[1]);
      continue;
    }

    if (/^[A-Z][A-Z /-]+ LIST:$/.test(line)) {
      readingList = true;
      continue;
    }

    if (
      line.startsWith("==============================") ||
      line === "AUDIT FINISHED" ||
      line === "NOTHING WAS DELETED"
    ) {
      readingList = false;
      continue;
    }

    if (!readingList) {
      continue;
    }

    const itemMatch = line.match(/^(\d+)\.\s+(.+)$/);

    if (itemMatch) {
      const position = Number(itemMatch[1]);
      const name = itemMatch[2].trim();

      resources[activeKey].items.push({
        id: makeItemId(activeKey, position, name),
        position,
        name,
        type: activeKey,
      });
    }
  }

  for (const resource of Object.values(resources)) {
    if (resource.items.length > resource.count) {
      resource.count = resource.items.length;
    }

    const seen = new Set();

    resource.items = resource.items.filter((item) => {
      const key = `${item.position}:${item.name}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  return {
    locationName,
    resources,
  };
}

module.exports = {
  parseAuditOutput,
  createEmptyResources,
};
