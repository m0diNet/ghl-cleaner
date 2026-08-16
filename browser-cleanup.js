require("dotenv").config();

const {
  closeBrowserlessSession,
  connectBrowserless,
  formatBrowserlessError,
} = require("./services/browserless");

const LOCATION_ID = String(process.env.GHL_LOCATION_ID || "").trim();
const MODE = process.env.BROWSER_MODE || "selected";
const AUTO_CLOSE = process.env.BROWSER_AUTO_CLOSE === "true";

const TARGETS = (() => {
  try {
    const value = JSON.parse(process.env.BROWSER_TARGETS || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
})();

const REQUESTED_CATEGORIES = (() => {
  try {
    const value = JSON.parse(process.env.BROWSER_CATEGORIES || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
})();

const URLS = {
  workflows: `https://app.gohighlevel.com/v2/location/${LOCATION_ID}/automation/workflows?listTab=all`,
  funnels: `https://app.gohighlevel.com/v2/location/${LOCATION_ID}/funnels-websites/funnels`,
  forms: `https://app.gohighlevel.com/v2/location/${LOCATION_ID}/form-builder/main`,
};

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function record(category, name, status, error = null) {
  const entry = {
    category,
    name,
    status,
    error,
  };

  results.push(entry);

  const icon = status === "deleted" ? "✅" : status === "skipped" ? "⏭️" : "❌";
  console.log(`${icon} [${category}] ${name}${error ? ` — ${error}` : ""}`);
}

async function isVisible(locator) {
  return locator.isVisible().catch(() => false);
}

async function waitForAuthenticatedPage(page, category) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 120000) {
    const url = page.url();

    if (/login|signin|auth/i.test(url)) {
      console.log(`Waiting for GHL login before deleting ${category}...`);
      await sleep(1500);
      continue;
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");

    if (new RegExp(category.slice(0, -1), "i").test(bodyText)) {
      return;
    }

    await sleep(1000);
  }

  throw new Error(`${category} page did not become ready.`);
}

async function getWorkflowFrame(page) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 120000) {
    const frame = page
      .frames()
      .find((candidate) =>
        candidate.url().includes("client-app-automation-workflows.leadconnectorhq.com")
      );

    if (frame) {
      const bodyText = await frame.locator("body").innerText().catch(() => "");
      if (/workflow/i.test(bodyText)) {
        return frame;
      }
    }

    await sleep(1000);
  }

  throw new Error("Workflow iframe did not load.");
}

async function findRows(scope) {
  const selectors = [
    "table tbody tr",
    '[role="table"] [role="row"]',
    '[role="grid"] [role="row"]',
  ];

  for (const selector of selectors) {
    const rows = scope.locator(selector);
    if ((await rows.count().catch(() => 0)) > 0) {
      return rows;
    }
  }

  return null;
}

async function rowLines(row) {
  return (await row.innerText().catch(() => ""))
    .split("\n")
    .map(cleanText)
    .filter(Boolean);
}

async function rowName(row, category) {
  const lines = await rowLines(row);

  if (category === "workflows") {
    return (
      lines.find(
        (line) =>
          !/^(name|status|total enrolled|active enrolled|last updated|created on|stats|\d+)$/i.test(
            line
          )
      ) || lines[0] || ""
    );
  }

  return lines[0] || "";
}

async function findActionButton(row) {
  const candidates = [
    row.locator('[aria-label*="action" i]').last(),
    row.locator('button[aria-haspopup="menu"]').last(),
    row.locator("button").last(),
  ];

  for (const candidate of candidates) {
    if (await isVisible(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function findDeleteMenuItem(scope, page, category) {
  const patterns =
    category === "workflows"
      ? /^(delete workflow|delete folder|delete)$/i
      : /^(delete|delete folder)$/i;

  const candidates = [
    scope.getByText(patterns).last(),
    page.getByText(patterns).last(),
    page.getByRole("menuitem", { name: patterns }).last(),
  ];

  for (const candidate of candidates) {
    if (await isVisible(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function confirmDelete(scope, page) {
  const inputCandidates = [
    scope.locator('input:visible').last(),
    page.locator('input:visible').last(),
  ];

  for (const input of inputCandidates) {
    if (await isVisible(input)) {
      const placeholder = await input.getAttribute("placeholder").catch(() => "");
      const nearby = cleanText(
        await input.locator("xpath=..").innerText().catch(() => "")
      );

      if (/delete/i.test(`${placeholder} ${nearby}`)) {
        await input.fill("Delete");
        break;
      }
    }
  }

  const buttons = [
    scope.getByRole("button", { name: /^delete$/i }).last(),
    page.getByRole("button", { name: /^delete$/i }).last(),
    page.getByRole("button", { name: /confirm/i }).last(),
    page.getByRole("button", { name: /yes.*delete/i }).last(),
  ];

  for (const button of buttons) {
    if (await isVisible(button)) {
      await button.click();
      return;
    }
  }

  throw new Error("Delete confirmation button was not found.");
}

async function findNextButton(scope) {
  const candidates = [
    scope.getByRole("button", { name: /^next$/i }).last(),
    scope.locator('button[aria-label*="next" i]').last(),
    scope.locator('button:has-text("Next")').last(),
  ];

  for (const candidate of candidates) {
    if (await isVisible(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function deleteOneFromCurrentPage(scope, page, category, targetName) {
  const rows = await findRows(scope);

  if (!rows) {
    return false;
  }

  const count = await rows.count();

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);

    if (!(await isVisible(row))) {
      continue;
    }

    const name = await rowName(row, category);

    if (cleanText(name) !== cleanText(targetName)) {
      continue;
    }

    const actionButton = await findActionButton(row);

    if (!actionButton) {
      throw new Error(`Action menu was not found for "${targetName}".`);
    }

    await actionButton.click();
    await sleep(350);

    const deleteItem = await findDeleteMenuItem(scope, page, category);

    if (!deleteItem) {
      await page.keyboard.press("Escape").catch(() => {});
      throw new Error(`Delete menu item was not found for "${targetName}".`);
    }

    await deleteItem.click();
    await sleep(350);

    await confirmDelete(scope, page);
    await sleep(1300);

    return true;
  }

  return false;
}

async function deleteNamedTargets(scope, page, category, targetItems) {
  const pending = targetItems.map((item) => cleanText(item.name)).filter(Boolean);
  const failedOnce = new Set();

  while (pending.length) {
    const targetName = pending[0];
    let found = false;
    let pageNumber = 1;
    const signatures = new Set();

    while (pageNumber <= 100) {
      await sleep(700);

      const rows = await findRows(scope);
      const signature = rows
        ? cleanText(await rows.allInnerTexts().then((values) => values.join("||")).catch(() => ""))
        : "";

      if (signatures.has(signature)) {
        break;
      }

      signatures.add(signature);

      try {
        found = await deleteOneFromCurrentPage(
          scope,
          page,
          category,
          targetName
        );
      } catch (error) {
        record(category, targetName, "failed", error.message);
        pending.shift();
        found = true;
        break;
      }

      if (found) {
        record(category, targetName, "deleted");
        pending.shift();
        break;
      }

      const nextButton = await findNextButton(scope);

      if (!nextButton) {
        break;
      }

      const disabled = await nextButton.isDisabled().catch(() => false);
      const ariaDisabled = await nextButton.getAttribute("aria-disabled").catch(() => null);

      if (disabled || ariaDisabled === "true") {
        break;
      }

      await nextButton.click();
      await sleep(1000);
      pageNumber += 1;
    }

    if (!found) {
      if (!failedOnce.has(targetName)) {
        failedOnce.add(targetName);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await sleep(1500);

        if (category === "workflows") {
          scope = await getWorkflowFrame(page);
        }

        continue;
      }

      record(category, targetName, "failed", "Not found");
      pending.shift();
    }
  }
}

async function deleteAllVisible(scope, page, category) {
  let safety = 0;

  while (safety < 1000) {
    safety += 1;

    const rows = await findRows(scope);
    if (!rows || (await rows.count()) === 0) {
      break;
    }

    let deleted = false;
    const count = await rows.count();

    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);

      if (!(await isVisible(row))) {
        continue;
      }

      const name = await rowName(row, category);

      if (!name || /^(name|status|updated on|last updated)$/i.test(name)) {
        continue;
      }

      try {
        deleted = await deleteOneFromCurrentPage(scope, page, category, name);

        if (deleted) {
          record(category, name, "deleted");
          break;
        }
      } catch (error) {
        record(category, name, "failed", error.message);
      }
    }

    if (!deleted) {
      break;
    }
  }
}

async function deleteCategory(context, category) {
  const page = await context.newPage();

  try {
    await page.goto(URLS[category], {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await waitForAuthenticatedPage(page, category);

    const scope =
      category === "workflows"
        ? await getWorkflowFrame(page)
        : page;

    if (MODE === "all") {
      await deleteAllVisible(scope, page, category);
      return;
    }

    const targets = Array.isArray(TARGETS[category]) ? TARGETS[category] : [];

    if (!targets.length) {
      record(category, category, "skipped", "No selected items");
      return;
    }

    await deleteNamedTargets(scope, page, category, targets);
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  if (!LOCATION_ID) {
    throw new Error("Missing GHL_LOCATION_ID");
  }

  const categories = REQUESTED_CATEGORIES.filter(
    (category) => URLS[category]
  );

  if (!categories.length) {
    throw new Error("No browser categories were requested.");
  }

  console.log("Browser automation: Browserless remote");

  const session = await connectBrowserless({
    timeoutMs: 45000,
    createPage: false,
  });

  const { context } = session;

  try {
    for (const category of categories) {
      console.log(`Opening ${category} directly...`);
      await deleteCategory(context, category);
    }
  } finally {
    const summary = {
      results,
      deleted: results.filter((item) => item.status === "deleted").length,
      failed: results.filter((item) => item.status === "failed").length,
      skipped: results.filter((item) => item.status === "skipped").length,
    };

    console.log(`BROWSER_RESULT_JSON:${JSON.stringify(summary)}`);
    await closeBrowserlessSession(session);
  }
})().catch((error) => {
  console.error(error);

  console.log(
    `BROWSER_RESULT_JSON:${JSON.stringify({
      results: [
        {
          category: "browser",
          name: "Browser cleanup",
          status: "failed",
          error: formatBrowserlessError(error),
        },
      ],
      deleted: 0,
      failed: 1,
      skipped: 0,
    })}`
  );

  process.exitCode = 1;
});
