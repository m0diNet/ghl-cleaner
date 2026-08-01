const connectionForm =
  document.getElementById(
    "connection-form"
  );

const locationInput =
  document.getElementById(
    "location-id"
  );

const tokenInput =
  document.getElementById(
    "integration-token"
  );

const testButton =
  document.getElementById(
    "test-button"
  );

const toggleTokenButton =
  document.getElementById(
    "toggle-token"
  );

const resultBox =
  document.getElementById(
    "connection-result"
  );

const accountCard =
  document.getElementById(
    "account-card"
  );

const accountName =
  document.getElementById(
    "account-name"
  );

const accountLocation =
  document.getElementById(
    "account-location"
  );

const scanButton =
  document.getElementById(
    "scan-button"
  );

const scanSection =
  document.getElementById(
    "scan-section"
  );

const scanStatus =
  document.getElementById(
    "scan-status"
  );

const resourcesContainer =
  document.getElementById(
    "resources-container"
  );


let currentConnection = {
  locationId: "",
  token: "",
};


let latestResources = {};

let deletableCategories = [];

const selectionState =
  new Map();


// =====================================================
// CONNECTION
// =====================================================

toggleTokenButton.addEventListener(
  "click",
  () => {
    const hidden =
      tokenInput.type ===
      "password";

    tokenInput.type =
      hidden
        ? "text"
        : "password";

    toggleTokenButton.textContent =
      hidden
        ? "Hide"
        : "Show";
  }
);


connectionForm.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    const locationId =
      locationInput.value.trim();

    const token =
      tokenInput.value.trim();


    resultBox.className =
      "result loading";

    resultBox.textContent =
      "Testing connection...";


    testButton.disabled =
      true;

    testButton.textContent =
      "Connecting...";

    scanButton.disabled =
      true;

    scanSection.classList.add(
      "hidden"
    );


    try {
      const response =
        await fetch(
          "/api/test-connection",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                locationId,
                token,
              }),
          }
        );


      const data =
        await response.json();


      if (
        !response.ok ||
        !data.success
      ) {
        throw new Error(
          data.details ||
          data.message ||
          "Connection failed."
        );
      }


      currentConnection = {
        locationId,
        token,
      };


      resultBox.className =
        "result success";

      resultBox.textContent =
        "Connection successful.";


      accountName.textContent =
        data.location.name;

      accountLocation.textContent =
        data.location.id;


      accountCard.classList.remove(
        "hidden"
      );

      scanButton.disabled =
        false;


      tokenInput.type =
        "password";

      toggleTokenButton.textContent =
        "Show";
    } catch (error) {
      resultBox.className =
        "result error";

      resultBox.textContent =
        error.message;

      accountCard.classList.add(
        "hidden"
      );
    } finally {
      testButton.disabled =
        false;

      testButton.textContent =
        "Test Connection";
    }
  }
);


// =====================================================
// SCAN ACCOUNT
// =====================================================

scanButton.addEventListener(
  "click",
  scanAccount
);


async function scanAccount() {
  scanButton.disabled =
    true;

  scanButton.textContent =
    "Scanning...";


  scanSection.classList.remove(
    "hidden"
  );

  scanStatus.className =
    "result loading";

  scanStatus.textContent =
    "Scanning the GHL account. Large accounts may take a few minutes...";


  resourcesContainer.innerHTML =
    "";

  selectionState.clear();

  removeDeletionPanel();


  try {
    const response =
      await fetch(
        "/api/scan",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify(
              currentConnection
            ),
        }
      );


    const data =
      await response.json();


    if (
      !response.ok ||
      !data.success
    ) {
      throw new Error(
        data.details ||
        data.message ||
        "Scan failed."
      );
    }


    latestResources =
      data.resources ||
      {};


    deletableCategories =
      data.deletableCategories ||
      [];


    scanStatus.className =
      "result success";

    scanStatus.textContent =
      `Scan complete: ${data.location.name}`;


    renderResources(
      latestResources
    );

    createDeletionPanel();
  } catch (error) {
    scanStatus.className =
      "result error";

    scanStatus.textContent =
      error.message;
  } finally {
    scanButton.disabled =
      false;

    scanButton.textContent =
      "Scan Account";
  }
}


// =====================================================
// RESOURCE BROWSER
// =====================================================

function getSelectedSet(
  category
) {
  if (
    !selectionState.has(
      category
    )
  ) {
    selectionState.set(
      category,
      new Set()
    );
  }

  return selectionState.get(
    category
  );
}


function renderResources(
  resources
) {
  resourcesContainer.innerHTML =
    "";

  for (
    const [
      category,
      resource,
    ] of Object.entries(
      resources
    )
  ) {
    resourcesContainer.appendChild(
      createResourceCard(
        category,
        resource
      )
    );
  }
}


function createResourceCard(
  category,
  resource
) {
  const selected =
    getSelectedSet(
      category
    );

  const card =
    document.createElement(
      "section"
    );

  card.className =
    "resource-card";


  const categoryDeletable =
    deletableCategories.includes(
      category
    );


  const header =
    document.createElement(
      "button"
    );

  header.type =
    "button";

  header.className =
    "resource-header";


  header.innerHTML = `
    <span class="resource-title">
      <input
        type="checkbox"
        class="category-checkbox"
        aria-label="Select ${escapeHtml(
          resource.label
        )}"
      />

      <strong>
        ${escapeHtml(resource.label)}
      </strong>

      ${
        categoryDeletable
          ? `
            <span class="api-ready-badge">
              Deletion ready
            </span>
          `
          : `
            <span class="view-only-badge">
              View/select only
            </span>
          `
      }
    </span>

    <span class="resource-meta">
      <span class="selected-badge">
        0 selected
      </span>

      <span class="count-badge">
        ${resource.count}
      </span>

      <span class="open-label">
        Open
      </span>
    </span>
  `;


  const details =
    document.createElement(
      "div"
    );

  details.className =
    "resource-details hidden";


  card.appendChild(
    header
  );

  card.appendChild(
    details
  );


  const categoryCheckbox =
    header.querySelector(
      ".category-checkbox"
    );


  header.addEventListener(
    "click",
    (event) => {
      if (
        event.target ===
        categoryCheckbox
      ) {
        return;
      }

      details.classList.toggle(
        "hidden"
      );

      header.querySelector(
        ".open-label"
      ).textContent =
        details.classList.contains(
          "hidden"
        )
          ? "Open"
          : "Close";
    }
  );


  if (
    !resource.items.length
  ) {
    details.innerHTML = `
      <p class="empty-message">
        No individual item names were returned.
        Total reported by GHL:
        ${resource.count}
      </p>
    `;

    categoryCheckbox.disabled =
      true;

    return card;
  }


  buildResourceBrowser({
    header,
    details,
    category,
    resource,
    selected,
    categoryCheckbox,
  });


  return card;
}


function buildResourceBrowser({
  header,
  details,
  category,
  resource,
  selected,
  categoryCheckbox,
}) {
  let searchText =
    "";

  let selectionFilter =
    "all";

  let sortOrder =
    "az";

  let pageSize =
    50;

  let currentPage =
    1;


  details.innerHTML = `
    <div class="resource-dashboard">
      <div class="resource-summary">
        <div>
          <span class="summary-number">
            ${resource.items.length}
          </span>

          <span>
            Total loaded
          </span>
        </div>

        <div>
          <span class="summary-number filtered-number">
            ${resource.items.length}
          </span>

          <span>
            Filtered
          </span>
        </div>

        <div>
          <span class="summary-number selected-number">
            0
          </span>

          <span>
            Selected
          </span>
        </div>
      </div>


      <div class="big-filter">
        <label>
          Search all
          ${escapeHtml(resource.label)}
        </label>

        <input
          type="search"
          class="resource-search large-search"
          placeholder="Type any part of the item name..."
        />
      </div>


      <div class="filter-toolbar">
        <select class="selection-filter">
          <option value="all">
            Show all
          </option>

          <option value="selected">
            Selected only
          </option>

          <option value="unselected">
            Unselected only
          </option>
        </select>


        <select class="sort-order">
          <option value="az">
            Sort A–Z
          </option>

          <option value="za">
            Sort Z–A
          </option>
        </select>


        <select class="page-size">
          <option value="25">
            25 per page
          </option>

          <option value="50" selected>
            50 per page
          </option>

          <option value="100">
            100 per page
          </option>

          <option value="250">
            250 per page
          </option>
        </select>


        <button
          type="button"
          class="small-button select-filtered"
        >
          Select filtered
        </button>


        <button
          type="button"
          class="small-button clear-filtered"
        >
          Clear filtered
        </button>


        <button
          type="button"
          class="small-button clear-all"
        >
          Clear all
        </button>
      </div>


      <div class="resource-list">
      </div>


      <div class="pagination-bar">
        <button
          type="button"
          class="small-button previous-page"
        >
          Previous
        </button>

        <span class="page-information">
        </span>

        <button
          type="button"
          class="small-button next-page"
        >
          Next
        </button>
      </div>
    </div>
  `;


  const searchInput =
    details.querySelector(
      ".resource-search"
    );

  const filterSelect =
    details.querySelector(
      ".selection-filter"
    );

  const sortSelect =
    details.querySelector(
      ".sort-order"
    );

  const pageSizeSelect =
    details.querySelector(
      ".page-size"
    );

  const list =
    details.querySelector(
      ".resource-list"
    );

  const previousButton =
    details.querySelector(
      ".previous-page"
    );

  const nextButton =
    details.querySelector(
      ".next-page"
    );

  const pageInformation =
    details.querySelector(
      ".page-information"
    );


  function getFilteredItems() {
    let items =
      resource.items.filter(
        (item) => {
          const name =
            String(
              item.name
            ).toLowerCase();


          if (
            searchText &&
            !name.includes(
              searchText
            )
          ) {
            return false;
          }


          const isSelected =
            selected.has(
              item.id
            );


          if (
            selectionFilter ===
            "selected"
          ) {
            return isSelected;
          }


          if (
            selectionFilter ===
            "unselected"
          ) {
            return !isSelected;
          }


          return true;
        }
      );


    items.sort(
      (a, b) => {
        const comparison =
          String(
            a.name
          ).localeCompare(
            String(
              b.name
            ),
            undefined,
            {
              sensitivity:
                "base",

              numeric:
                true,
            }
          );


        return sortOrder ===
          "az"
          ? comparison
          : -comparison;
      }
    );


    return items;
  }


  function updateCounters(
    filteredItems
  ) {
    details.querySelector(
      ".filtered-number"
    ).textContent =
      filteredItems.length;


    details.querySelector(
      ".selected-number"
    ).textContent =
      selected.size;


    header.querySelector(
      ".selected-badge"
    ).textContent =
      `${selected.size} selected`;


    categoryCheckbox.checked =
      selected.size ===
      resource.items.length;


    categoryCheckbox.indeterminate =
      selected.size > 0 &&
      selected.size <
        resource.items.length;


    updateDeleteReviewButton();
  }


  function renderList() {
    const filteredItems =
      getFilteredItems();


    const totalPages =
      Math.max(
        1,
        Math.ceil(
          filteredItems.length /
          pageSize
        )
      );


    if (
      currentPage >
      totalPages
    ) {
      currentPage =
        totalPages;
    }


    const start =
      (
        currentPage -
        1
      ) *
      pageSize;


    const pageItems =
      filteredItems.slice(
        start,
        start + pageSize
      );


    list.innerHTML =
      "";


    if (
      !pageItems.length
    ) {
      list.innerHTML = `
        <p class="empty-filter-message">
          No items match the current filter.
        </p>
      `;
    } else {
      for (
        const item of
        pageItems
      ) {
        const row =
          document.createElement(
            "label"
          );

        row.className =
          "resource-item";


        row.innerHTML = `
          <input
            type="checkbox"
            ${
              selected.has(
                item.id
              )
                ? "checked"
                : ""
            }
          />

          <span class="item-position">
            ${item.position || ""}
          </span>

          <span class="item-name">
            ${escapeHtml(item.name)}
          </span>
        `;


        const checkbox =
          row.querySelector(
            "input"
          );


        checkbox.addEventListener(
          "change",
          () => {
            if (
              checkbox.checked
            ) {
              selected.add(
                item.id
              );
            } else {
              selected.delete(
                item.id
              );
            }

            renderList();
          }
        );


        list.appendChild(
          row
        );
      }
    }


    updateCounters(
      filteredItems
    );


    pageInformation.textContent =
      `Page ${currentPage} of ${totalPages} — ${filteredItems.length} matching items`;


    previousButton.disabled =
      currentPage <= 1;


    nextButton.disabled =
      currentPage >=
      totalPages;
  }


  searchInput.addEventListener(
    "input",
    () => {
      searchText =
        searchInput.value
          .trim()
          .toLowerCase();

      currentPage =
        1;

      renderList();
    }
  );


  filterSelect.addEventListener(
    "change",
    () => {
      selectionFilter =
        filterSelect.value;

      currentPage =
        1;

      renderList();
    }
  );


  sortSelect.addEventListener(
    "change",
    () => {
      sortOrder =
        sortSelect.value;

      currentPage =
        1;

      renderList();
    }
  );


  pageSizeSelect.addEventListener(
    "change",
    () => {
      pageSize =
        Number(
          pageSizeSelect.value
        );

      currentPage =
        1;

      renderList();
    }
  );


  details
    .querySelector(
      ".select-filtered"
    )
    .addEventListener(
      "click",
      () => {
        for (
          const item of
          getFilteredItems()
        ) {
          selected.add(
            item.id
          );
        }

        renderList();
      }
    );


  details
    .querySelector(
      ".clear-filtered"
    )
    .addEventListener(
      "click",
      () => {
        for (
          const item of
          getFilteredItems()
        ) {
          selected.delete(
            item.id
          );
        }

        renderList();
      }
    );


  details
    .querySelector(
      ".clear-all"
    )
    .addEventListener(
      "click",
      () => {
        selected.clear();

        renderList();
      }
    );


  previousButton.addEventListener(
    "click",
    () => {
      currentPage--;

      renderList();
    }
  );


  nextButton.addEventListener(
    "click",
    () => {
      currentPage++;

      renderList();
    }
  );


  categoryCheckbox.addEventListener(
    "change",
    () => {
      if (
        categoryCheckbox.checked
      ) {
        for (
          const item of
          resource.items
        ) {
          selected.add(
            item.id
          );
        }
      } else {
        selected.clear();
      }

      renderList();
    }
  );


  renderList();
}


// =====================================================
// REVIEW SELECTED ITEMS
// =====================================================

function removeDeletionPanel() {
  document
    .getElementById(
      "deletion-panel"
    )
    ?.remove();
}


function createDeletionPanel() {
  removeDeletionPanel();


  const panel =
    document.createElement(
      "section"
    );

  panel.id =
    "deletion-panel";

  panel.className =
    "deletion-panel";


  panel.innerHTML = `
    <div class="deletion-panel-header">
      <div>
        <p class="eyebrow">
          SELECTED CLEANUP
        </p>

        <h3>
          Review selected items
        </h3>

        <p>
          Only checked items are sent
          to the cleanup engine.
        </p>
      </div>

      <button
        id="review-selected-button"
        type="button"
        class="primary-button"
        disabled
      >
        Review Selected
      </button>
    </div>

    <div
      id="delete-review"
      class="delete-review hidden"
    >
    </div>
  `;


  scanSection.appendChild(
    panel
  );


  panel
    .querySelector(
      "#review-selected-button"
    )
    .addEventListener(
      "click",
      showSelectedReview
    );


  updateDeleteReviewButton();
}


function countAllSelected() {
  let total =
    0;

  for (
    const selected of
    selectionState.values()
  ) {
    total +=
      selected.size;
  }

  return total;
}


function updateDeleteReviewButton() {
  const button =
    document.getElementById(
      "review-selected-button"
    );


  if (!button) {
    return;
  }


  const total =
    countAllSelected();


  button.textContent =
    total
      ? `Review Selected (${total})`
      : "Review Selected";


  button.disabled =
    total === 0;
}


function getSelectedItemsByCategory() {
  const selections =
    {};


  for (
    const [
      category,
      selectedIds,
    ] of selectionState
  ) {
    const resource =
      latestResources[
        category
      ];


    if (
      !resource?.items
    ) {
      continue;
    }


    selections[
      category
    ] =
      resource.items
        .filter(
          (item) =>
            selectedIds.has(
              item.id
            )
        )
        .map(
          (item) => ({
            id:
              item.id,

            name:
              item.name,

            realId:
              item.realId ===
              true,
          })
        );
  }


  return selections;
}


function showSelectedReview() {
  const review =
    document.getElementById(
      "delete-review"
    );


  const selections =
    getSelectedItemsByCategory();


  const readySelections =
    {};

  const waitingSelections =
    {};


  let readyTotal =
    0;

  let waitingTotal =
    0;


  for (
    const [
      category,
      items,
    ] of Object.entries(
      selections
    )
  ) {
    if (
      deletableCategories.includes(
        category
      )
    ) {
      readySelections[
        category
      ] =
        items.filter(
          (item) =>
            item.realId
        );

      readyTotal +=
        readySelections[
          category
        ].length;
    } else {
      waitingSelections[
        category
      ] =
        items;

      waitingTotal +=
        items.length;
    }
  }


  review.classList.remove(
    "hidden"
  );


  review.innerHTML = `
    <div class="review-warning">
      <strong>
        Permanent deletion
      </strong>

      <p>
        Only the exact checked items shown
        under “Ready to delete” will be deleted.
      </p>
    </div>


    <div class="review-summary-grid">
      <div>
        <strong>
          ${readyTotal}
        </strong>

        <span>
          Ready to delete
        </span>
      </div>

      <div>
        <strong>
          ${waitingTotal}
        </strong>

        <span>
          Waiting for browser deletion support
        </span>
      </div>
    </div>


    ${renderReviewGroups(
      readySelections,
      "Ready to delete"
    )}


    ${renderReviewGroups(
      waitingSelections,
      "Selected but not connected to deletion yet"
    )}


    <div class="delete-confirmation-area">
      <label for="delete-confirmation-input">
        Type DELETE to confirm
      </label>

      <input
        id="delete-confirmation-input"
        type="text"
        autocomplete="off"
        placeholder="DELETE"
      />

      <button
        id="start-selected-delete"
        type="button"
        class="danger-button"
        disabled
      >
        Delete Selected Items
      </button>
    </div>


    <div
      id="delete-progress"
      class="hidden"
    >
    </div>
  `;


  const input =
    review.querySelector(
      "#delete-confirmation-input"
    );


  const button =
    review.querySelector(
      "#start-selected-delete"
    );


  input.addEventListener(
    "input",
    () => {
      button.disabled =
        input.value !==
          "DELETE" ||
        readyTotal ===
          0;
    }
  );


  button.addEventListener(
    "click",
    () => {
      deleteSelectedItems(
        readySelections,
        input,
        button
      );
    }
  );


  review.scrollIntoView({
    behavior:
      "smooth",

    block:
      "start",
  });
}


function renderReviewGroups(
  groups,
  heading
) {
  const populated =
    Object.entries(
      groups
    ).filter(
      (
        [
          ,
          items,
        ]
      ) =>
        items.length
    );


  if (
    !populated.length
  ) {
    return "";
  }


  return `
    <h4 class="review-section-title">
      ${escapeHtml(heading)}
    </h4>

    ${populated
      .map(
        (
          [
            category,
            items,
          ]
        ) => {
          const label =
            latestResources[
              category
            ]?.label ||
            category;


          return `
            <section class="review-category">
              <h4>
                ${escapeHtml(label)}

                <span>
                  ${items.length}
                </span>
              </h4>

              <div class="review-item-list">
                ${items
                  .map(
                    (item) => `
                      <div class="review-item">
                        ${escapeHtml(item.name)}
                      </div>
                    `
                  )
                  .join("")}
              </div>
            </section>
          `;
        }
      )
      .join("")}
  `;
}


// =====================================================
// DELETE SELECTED ITEMS
// =====================================================

async function deleteSelectedItems(
  selections,
  confirmationInput,
  deleteButton
) {
  const progress =
    document.getElementById(
      "delete-progress"
    );


  deleteButton.disabled =
    true;

  confirmationInput.disabled =
    true;


  progress.className =
    "result loading";

  progress.textContent =
    "Deleting only the selected items...";


  try {
    const response =
      await fetch(
        "/api/delete-selected",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify({
              ...currentConnection,

              confirmation:
                confirmationInput.value,

              selections,
            }),
        }
      );


    const data =
      await response.json();


    if (
      !response.ok ||
      (
        !data.success &&
        !Array.isArray(
          data.results
        )
      )
    ) {
      throw new Error(
        data.details ||
        data.message ||
        "Deletion failed."
      );
    }


    progress.className =
      data.failed
        ? "delete-results warning-results"
        : "delete-results success-results";


    progress.innerHTML = `
      <h4>
        Cleanup finished
      </h4>

      <p>
        Deleted:
        <strong>
          ${data.deleted}
        </strong>

        &nbsp;

        Failed:
        <strong>
          ${data.failed}
        </strong>
      </p>

      <div class="delete-result-list">
        ${(data.results || [])
          .map(
            (result) => `
              <div class="delete-result-row ${result.status}">
                <span>
                  ${
                    result.status ===
                    "deleted"
                      ? "Deleted"
                      : "Failed"
                  }
                </span>

                <strong>
                  ${escapeHtml(result.name)}
                </strong>

                ${
                  result.error
                    ? `
                      <small>
                        ${escapeHtml(result.error)}
                      </small>
                    `
                    : ""
                }
              </div>
            `
          )
          .join("")}
      </div>

      <button
        id="rescan-after-delete"
        type="button"
        class="primary-button"
      >
        Scan Account Again
      </button>
    `;


    progress
      .querySelector(
        "#rescan-after-delete"
      )
      .addEventListener(
        "click",
        scanAccount
      );
  } catch (error) {
    progress.className =
      "result error";

    progress.textContent =
      error.message;


    deleteButton.disabled =
      false;

    confirmationInput.disabled =
      false;
  }
}


// =====================================================
// HTML SAFETY
// =====================================================

function escapeHtml(value) {
  return String(value)
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}