require("dotenv").config();

const { chromium } = require("playwright");
const path = require("path");

const LOCATION_ID = process.env.GHL_LOCATION_ID;
const DELETE_MODE =
  String(process.env.BROWSER_DELETE).toLowerCase() === "true";

const URLS = {
  workflows:
    `https://app.gohighlevel.com/v2/location/${LOCATION_ID}/automation/workflows?listTab=all`,

  funnels:
    `https://app.gohighlevel.com/v2/location/${LOCATION_ID}/funnels-websites/funnels`,

  forms:
    `https://app.gohighlevel.com/v2/location/${LOCATION_ID}/form-builder/main`,
};

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));


// =====================================================
// GENERIC HELPERS
// =====================================================

async function waitForCountGreaterThanZero(
  locator,
  label,
  timeout = 120000
) {
  console.log(`Waiting for ${label}...`);

  const start = Date.now();

  while (Date.now() - start < timeout) {
    const count = await locator.count();

    if (count > 0) {
      console.log(`✅ ${label} found: ${count}`);
      return count;
    }

    await sleep(1000);
  }

  throw new Error(
    `${label} did not appear within timeout.`
  );
}


async function waitForVisible(
  locator,
  label,
  timeout = 30000
) {
  console.log(`Waiting for ${label}...`);

  await locator.first().waitFor({
    state: "visible",
    timeout,
  });

  console.log(`✅ ${label} ready`);
}


// =====================================================
// WORKFLOW FRAME
// =====================================================

async function getWorkflowFrame(page) {
  console.log("Waiting for workflow iframe...");

  const start = Date.now();

  while (Date.now() - start < 120000) {
    const frame = page.frames().find((f) =>
      f.url().includes(
        "client-app-automation-workflows.leadconnectorhq.com"
      )
    );

    if (frame) {
      const actions = frame.locator(
        '[aria-label="Workflow list actions"]'
      );

      if ((await actions.count()) > 0) {
        console.log(
          "✅ Workflow iframe and rows ready"
        );

        return frame;
      }
    }

    await sleep(1000);
  }

  throw new Error(
    "Workflow iframe/content did not become ready."
  );
}


// =====================================================
// WORKFLOW ROW NAME
// =====================================================

async function getWorkflowRowName(actionButton) {
  try {
    const text = await actionButton.evaluate((el) => {
      const row =
        el.closest("tr") ||
        el.closest('[role="row"]');

      return row
        ? row.innerText || ""
        : "";
    });

    const ignored = new Set([
      "Name",
      "Status",
      "Total enrolled",
      "Active enrolled",
      "Last updated",
      "Created on",
      "Stats",
    ]);

    const lines = text
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .filter(
        (line) =>
          !ignored.has(line) &&
          !/^\d+$/.test(line) &&
          !/^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{4}/.test(line)
      );

    return (
      lines[0] ||
      "Unknown item"
    );
  } catch {
    return "Unknown item";
  }
}


// =====================================================
// INSPECT WORKFLOW / FOLDER
// =====================================================

async function inspectWorkflowItem(
  frame,
  page,
  actionButton
) {
  const name =
    await getWorkflowRowName(
      actionButton
    );

  await actionButton.click();

  const deleteWorkflow =
    frame
      .getByText(
        /^delete workflow$/i
      )
      .last();

  const deleteFolder =
    frame
      .getByText(
        /^delete folder$/i
      )
      .last();

  const start =
    Date.now();

  while (
    Date.now() - start <
    5000
  ) {
    if (
      await deleteWorkflow
        .isVisible()
        .catch(() => false)
    ) {
      return {
        name,
        type: "WORKFLOW",
        deleteLocator:
          deleteWorkflow,
      };
    }

    if (
      await deleteFolder
        .isVisible()
        .catch(() => false)
    ) {
      return {
        name,
        type: "FOLDER",
        deleteLocator:
          deleteFolder,
      };
    }

    await sleep(200);
  }

  await page.keyboard
    .press("Escape")
    .catch(() => {});

  return {
    name,
    type: "UNKNOWN",
    deleteLocator: null,
  };
}


// =====================================================
// SCAN WORKFLOW PAGE
// =====================================================

async function scanWorkflowPage(
  frame,
  page,
  pageNumber
) {
  const actions =
    frame.locator(
      '[aria-label="Workflow list actions"]'
    );

  const count =
    await actions.count();

  console.log("");
  console.log(
    `----- WORKFLOW PAGE ${pageNumber} -----`
  );

  console.log(
    `Rows on page: ${count}`
  );

  const inventory = [];

  for (
    let i = 0;
    i < count;
    i++
  ) {
    const currentActions =
      frame.locator(
        '[aria-label="Workflow list actions"]'
      );

    if (
      i >=
      await currentActions.count()
    ) {
      break;
    }

    console.log(
      `Inspecting row ${i + 1}/${count}...`
    );

    const item =
      await inspectWorkflowItem(
        frame,
        page,
        currentActions.nth(i)
      );

    inventory.push(item);

    console.log(
      `[${item.type}] ${item.name}`
    );

    await page.keyboard
      .press("Escape")
      .catch(() => {});

    await sleep(250);
  }

  return inventory;
}


// =====================================================
// PAGE SIGNATURE
// =====================================================

function makePageSignature(
  inventory
) {
  return inventory
    .map(
      (item) =>
        `${item.type}:${item.name}`
    )
    .join("||");
}


// =====================================================
// NEXT WORKFLOW PAGE
// =====================================================

async function goToNextWorkflowPage(
  frame,
  previousSignature
) {
  const next =
    frame
      .getByRole(
        "button",
        {
          name: /^next$/i,
        }
      )
      .last();

  if (
    !await next
      .isVisible()
      .catch(() => false)
  ) {
    return false;
  }

  if (
    await next
      .isDisabled()
      .catch(() => true)
  ) {
    console.log(
      "Next is disabled. Last page reached."
    );

    return false;
  }

  console.log(
    "Moving to next workflow page..."
  );

  await next.click();

  const previousNamesOnly =
    previousSignature
      .split("||")
      .map((x) =>
        x.replace(
          /^(WORKFLOW|FOLDER|UNKNOWN):/,
          ""
        )
      )
      .join("||");

  const start =
    Date.now();

  while (
    Date.now() - start <
    30000
  ) {
    const actions =
      frame.locator(
        '[aria-label="Workflow list actions"]'
      );

    const count =
      await actions.count();

    if (
      count > 0
    ) {
      const names = [];

      for (
        let i = 0;
        i < count;
        i++
      ) {
        names.push(
          await getWorkflowRowName(
            actions.nth(i)
          )
        );
      }

      if (
        names.join("||") !==
        previousNamesOnly
      ) {
        console.log(
          "✅ New workflow page loaded."
        );

        return true;
      }
    }

    await sleep(500);
  }

  console.log(
    "⚠️ Page did not change after clicking Next."
  );

  return false;
}


// =====================================================
// WORKFLOW INVENTORY MODE
// =====================================================

async function inventoryWorkflows(
  frame,
  page
) {
  console.log("");
  console.log(
    "WORKFLOW INVENTORY MODE"
  );

  console.log(
    "Nothing will be deleted."
  );

  const fullInventory = [];
  const seenPages =
    new Set();

  let pageNumber = 1;

  for (
    let safety = 0;
    safety < 100;
    safety++
  ) {
    const inventory =
      await scanWorkflowPage(
        frame,
        page,
        pageNumber
      );

    const signature =
      makePageSignature(
        inventory
      );

    if (
      seenPages.has(
        signature
      )
    ) {
      console.log("");
      console.log(
        "⚠️ Same workflow page detected again."
      );

      console.log(
        "Stopping pagination to avoid duplicate scanning."
      );

      break;
    }

    seenPages.add(
      signature
    );

    fullInventory.push(
      ...inventory
    );

    const moved =
      await goToNextWorkflowPage(
        frame,
        signature
      );

    if (!moved) {
      break;
    }

    pageNumber++;
  }

  const uniqueMap =
    new Map();

  for (
    const item of fullInventory
  ) {
    const key =
      `${item.type}::${item.name}`;

    if (
      !uniqueMap.has(key)
    ) {
      uniqueMap.set(
        key,
        item
      );
    }
  }

  const uniqueInventory =
    [...uniqueMap.values()];

  const workflows =
    uniqueInventory.filter(
      (x) =>
        x.type ===
        "WORKFLOW"
    );

  const folders =
    uniqueInventory.filter(
      (x) =>
        x.type ===
        "FOLDER"
    );

  const unknown =
    uniqueInventory.filter(
      (x) =>
        x.type ===
        "UNKNOWN"
    );

  console.log("");
  console.log(
    "================================="
  );

  console.log(
    "WORKFLOW INVENTORY SUMMARY"
  );

  console.log(
    "================================="
  );

  console.log("");
  console.log(
    "WORKFLOWS:"
  );

  workflows.forEach(
    (item) =>
      console.log(
        `- ${item.name}`
      )
  );

  console.log("");
  console.log(
    "FOLDERS:"
  );

  folders.forEach(
    (item) =>
      console.log(
        `- ${item.name}`
      )
  );

  if (
    unknown.length
  ) {
    console.log("");
    console.log(
      "UNKNOWN:"
    );

    unknown.forEach(
      (item) =>
        console.log(
          `- ${item.name}`
        )
    );
  }

  console.log("");
  console.log(
    `Workflows detected: ${workflows.length}`
  );

  console.log(
    `Folders detected: ${folders.length}`
  );

  console.log(
    `Unknown items: ${unknown.length}`
  );

  console.log("");
  console.log(
    "🟡 DRY RUN ONLY."
  );

  console.log(
    "🟡 NOTHING WAS DELETED."
  );
}


// =====================================================
// CONFIRM WORKFLOW / FOLDER DELETE
// =====================================================

async function confirmWorkflowDelete(
  frame,
  page
) {
  console.log(
    "Waiting for workflow/folder delete confirmation..."
  );

  /*
    GHL requires:
    1. Confirmation modal appears
    2. Type exactly: Delete
    3. Red Delete button becomes enabled
    4. Click Delete
  */

  const confirmationText =
    frame
      .getByText(
        /Type\s+Delete\s+to\s+confirm/i
      )
      .last();

  try {
    await confirmationText.waitFor({
      state: "visible",
      timeout: 10000,
    });
  } catch {
    console.log(
      "❌ Workflow delete confirmation modal was not found."
    );

    return false;
  }

  // Find visible input inside workflow iframe
  let confirmInput = null;

  const frameInputs =
    frame.locator(
      "input"
    );

  const inputCount =
    await frameInputs.count();

  for (
    let i =
      inputCount - 1;
    i >= 0;
    i--
  ) {
    const input =
      frameInputs.nth(i);

    if (
      await input
        .isVisible()
        .catch(() => false)
    ) {
      confirmInput =
        input;

      break;
    }
  }

  if (
    !confirmInput
  ) {
    console.log(
      '❌ Confirmation input for typing "Delete" was not found.'
    );

    return false;
  }

  console.log(
    'Typing "Delete" into confirmation box...'
  );

  await confirmInput.fill(
    "Delete"
  );

  const typedValue =
    await confirmInput.inputValue();

  if (
    typedValue !==
    "Delete"
  ) {
    console.log(
      `❌ Confirmation input contains "${typedValue}" instead of "Delete".`
    );

    return false;
  }

  console.log(
    '✅ Confirmation word "Delete" entered.'
  );

  // Find final red Delete button
  const deleteButtons =
    frame.getByRole(
      "button",
      {
        name: /^delete$/i,
      }
    );

  let finalDeleteButton =
    null;

  const buttonCount =
    await deleteButtons.count();

  for (
    let i =
      buttonCount - 1;
    i >= 0;
    i--
  ) {
    const button =
      deleteButtons.nth(i);

    if (
      await button
        .isVisible()
        .catch(() => false)
    ) {
      finalDeleteButton =
        button;

      break;
    }
  }

  // Fallback if modal is outside iframe
  if (
    !finalDeleteButton
  ) {
    const pageDeleteButtons =
      page.getByRole(
        "button",
        {
          name: /^delete$/i,
        }
      );

    const pageButtonCount =
      await pageDeleteButtons.count();

    for (
      let i =
        pageButtonCount - 1;
      i >= 0;
      i--
    ) {
      const button =
        pageDeleteButtons.nth(i);

      if (
        await button
          .isVisible()
          .catch(() => false)
      ) {
        finalDeleteButton =
          button;

        break;
      }
    }
  }

  if (
    !finalDeleteButton
  ) {
    console.log(
      "❌ Final Delete confirmation button was not found."
    );

    return false;
  }

  console.log(
    "Waiting for final Delete button to become enabled..."
  );

  const start =
    Date.now();

  while (
    Date.now() - start <
    15000
  ) {
    const disabled =
      await finalDeleteButton
        .isDisabled()
        .catch(() => false);

    if (
      !disabled
    ) {
      await finalDeleteButton.click();

      console.log(
        "✅ Workflow/folder deletion confirmed."
      );

      return true;
    }

    await sleep(250);
  }

  console.log(
    "❌ Final Delete button did not become enabled."
  );

  return false;
}


// =====================================================
// DELETE ONE WORKFLOW / FOLDER
// =====================================================

async function deleteOneWorkflowItem(
  frame,
  page
) {
  const actions =
    frame.locator(
      '[aria-label="Workflow list actions"]'
    );

  const count =
    await actions.count();

  if (!count) {
    return null;
  }

  for (
    let i = 0;
    i < count;
    i++
  ) {
    const currentActions =
      frame.locator(
        '[aria-label="Workflow list actions"]'
      );

    if (
      i >=
      await currentActions.count()
    ) {
      break;
    }

    const item =
      await inspectWorkflowItem(
        frame,
        page,
        currentActions.nth(i)
      );

    if (
      item.type !==
        "WORKFLOW" &&
      item.type !==
        "FOLDER"
    ) {
      await page.keyboard
        .press("Escape")
        .catch(() => {});

      continue;
    }

    console.log(
      `Deleting [${item.type}] ${item.name}`
    );

    await item.deleteLocator.click();

    const confirmed =
      await confirmWorkflowDelete(
        frame,
        page
      );

    if (
      !confirmed
    ) {
      throw new Error(
        `Could not confirm deletion for ${item.name}`
      );
    }

    console.log(
      `✅ Deleted [${item.type}] ${item.name}`
    );

    await sleep(1500);

    return item;
  }

  return null;
}


// =====================================================
// DELETE ALL WORKFLOWS / FOLDERS
// =====================================================

async function deleteAllWorkflows(
  frame,
  page
) {
  console.log("");
  console.log(
    "🔴 REAL WORKFLOW CLEANUP MODE"
  );

  let workflowsDeleted = 0;
  let foldersDeleted = 0;

  for (
    let safety = 0;
    safety < 500;
    safety++
  ) {
    const actions =
      frame.locator(
        '[aria-label="Workflow list actions"]'
      );

    const count =
      await actions.count();

    if (
      !count
    ) {
      console.log(
        "✅ No workflow rows remain."
      );

      break;
    }

    const item =
      await deleteOneWorkflowItem(
        frame,
        page
      );

    if (
      !item
    ) {
      console.log(
        "No deletable item found on current page."
      );

      break;
    }

    if (
      item.type ===
      "WORKFLOW"
    ) {
      workflowsDeleted++;
    }

    if (
      item.type ===
      "FOLDER"
    ) {
      foldersDeleted++;
    }

    console.log(
      `Deleted so far: ${workflowsDeleted} workflows / ${foldersDeleted} folders`
    );
  }

  console.log("");
  console.log(
    "WORKFLOW CLEANUP SUMMARY"
  );

  console.log(
    `Workflows deleted: ${workflowsDeleted}`
  );

  console.log(
    `Folders deleted: ${foldersDeleted}`
  );
}


// =====================================================
// MAIN WORKFLOW FUNCTION
// =====================================================

async function cleanupWorkflows(
  page
) {
  console.log("");
  console.log(
    "================================="
  );

  console.log(
    "WORKFLOWS"
  );

  console.log(
    "================================="
  );

  await page.goto(
    URLS.workflows,
    {
      waitUntil:
        "domcontentloaded",

      timeout:
        60000,
    }
  );

  const frame =
    await getWorkflowFrame(
      page
    );

  if (
    !DELETE_MODE
  ) {
    await inventoryWorkflows(
      frame,
      page
    );

    return;
  }

  await deleteAllWorkflows(
    frame,
    page
  );
}


// =====================================================
// FUNNELS / FORMS LOADER
// =====================================================

async function waitForActionRows(
  page,
  url,
  name
) {
  for (
    let attempt = 1;
    attempt <= 2;
    attempt++
  ) {
    console.log(
      `Opening ${name} - attempt ${attempt}/2`
    );

    await page.goto(
      url,
      {
        waitUntil:
          "domcontentloaded",

        timeout:
          60000,
      }
    );

    const actions =
      page.locator(
        '[aria-label="Actions"]'
      );

    try {
      await waitForCountGreaterThanZero(
        actions,
        `${name} rows`,
        120000
      );

      return true;
    } catch {
      if (
        attempt === 1
      ) {
        console.log(
          `⚠️ ${name} not ready. Retrying...`
        );
      }
    }
  }

  return false;
}


// =====================================================
// FUNNELS / FORMS CLEANUP
// =====================================================

async function cleanupActionRows(
  page,
  name,
  url
) {
  console.log("");
  console.log(
    "================================="
  );

  console.log(
    name.toUpperCase()
  );

  console.log(
    "================================="
  );

  const ready =
    await waitForActionRows(
      page,
      url,
      name
    );

  if (
    !ready
  ) {
    console.log(
      `❌ ${name} rows never became ready.`
    );

    return;
  }

  const actionsFactory =
    () =>
      page.locator(
        '[aria-label="Actions"]'
      );

  const initialCount =
    await actionsFactory().count();

  console.log(
    `${name} rows found: ${initialCount}`
  );


  // ==================================================
  // DRY RUN
  // ==================================================

  if (
    !DELETE_MODE
  ) {
    await actionsFactory()
      .first()
      .click();

    const deleteItem =
      page
        .getByText(
          /^(delete|delete folder)$/i
        )
        .last();

    try {
      await waitForVisible(
        deleteItem,
        `First ${name} row Delete option`,
        15000
      );

      console.log(
        `🟡 WOULD DELETE: First ${name} row`
      );
    } catch {
      console.log(
        `⚠️ First ${name} row does not show a Delete option.`
      );
    }

    await page.keyboard
      .press("Escape")
      .catch(() => {});

    return;
  }


  // ==================================================
  // REAL DELETE
  // ==================================================

  let deleted = 0;

  for (
    let safety = 0;
    safety < 300;
    safety++
  ) {
    const actions =
      actionsFactory();

    const beforeCount =
      await actions.count();

    if (
      !beforeCount
    ) {
      console.log(
        `✅ No more ${name} rows.`
      );

      break;
    }

    await actions
      .first()
      .click();

    const deleteItem =
      page
        .getByText(
          /^(delete|delete folder)$/i
        )
        .last();

    try {
      await deleteItem.waitFor({
        state: "visible",
        timeout: 10000,
      });
    } catch {
      console.log(
        `⚠️ ${name}: Delete option not found.`
      );

      await page.keyboard
        .press("Escape")
        .catch(() => {});

      break;
    }

    await deleteItem.click();

    const confirmations = [
      page
        .getByRole(
          "button",
          {
            name: /^delete$/i,
          }
        )
        .last(),

      page
        .getByRole(
          "button",
          {
            name: /confirm/i,
          }
        )
        .last(),

      page
        .getByRole(
          "button",
          {
            name: /yes.*delete/i,
          }
        )
        .last(),
    ];

    let confirmed = false;

    for (
      const confirm of confirmations
    ) {
      try {
        await confirm.waitFor({
          state: "visible",
          timeout: 5000,
        });

        await confirm.click();

        confirmed = true;

        break;
      } catch {
        // Try next confirmation.
      }
    }

    if (
      !confirmed
    ) {
      console.log(
        `⚠️ ${name}: confirmation button not detected.`
      );

      break;
    }

    deleted++;

    console.log(
      `✅ ${name} deleted. Total: ${deleted}`
    );

    await sleep(1500);
  }

  console.log("");
  console.log(
    `${name} deleted: ${deleted}`
  );
}


// =====================================================
// MAIN
// =====================================================

async function run() {
  const profilePath =
    path.join(
      __dirname,
      "ghl-browser-profile"
    );

  const context =
    await chromium.launchPersistentContext(
      profilePath,
      {
        headless: false,
        viewport: null,
      }
    );

  const pages =
    context.pages();

  const page =
    pages[0] ||
    (await context.newPage());

  console.log("");
  console.log(
    "================================="
  );

  console.log(
    "GHL SMART CLEANUP ENGINE"
  );

  console.log(
    "================================="
  );

  console.log(
    `MODE: ${
      DELETE_MODE
        ? "🔴 REAL DELETE"
        : "🟡 DRY RUN / INVENTORY"
    }`
  );

  console.log(
    "================================="
  );


  try {
    await cleanupWorkflows(
      page
    );
  } catch (error) {
    console.log(
      `❌ Workflows failed: ${error.message}`
    );
  }


  try {
    await cleanupActionRows(
      page,
      "Funnels",
      URLS.funnels
    );
  } catch (error) {
    console.log(
      `❌ Funnels failed: ${error.message}`
    );
  }


  try {
    await cleanupActionRows(
      page,
      "Forms",
      URLS.forms
    );
  } catch (error) {
    console.log(
      `❌ Forms failed: ${error.message}`
    );
  }


  console.log("");
  console.log(
    "================================="
  );

  if (
    DELETE_MODE
  ) {
    console.log(
      "REAL CLEANUP RUN FINISHED"
    );
  } else {
    console.log(
      "DRY RUN FINISHED"
    );

    console.log(
      "NOTHING WAS DELETED"
    );
  }

  console.log(
    "================================="
  );

  await new Promise(
    () => {}
  );
}


run().catch(
  (error) => {
    console.error(
      "FATAL ERROR:"
    );

    console.error(
      error
    );
  }
);