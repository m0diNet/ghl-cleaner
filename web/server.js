require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const { spawn } = require("child_process");

const {
  scanApiResources,
  deleteSelectedApiItems,
} = require("./services/ghlApi");

const app = express();

const PORT = Number(
  process.env.WEB_PORT || 3000
);

const PROJECT_ROOT = path.resolve(
  __dirname,
  ".."
);

app.use(
  express.json({
    limit: "2mb",
  })
);

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);


// =====================================================
// GENERAL HELPERS
// =====================================================

function cleanTerminalText(value) {
  return String(value || "")
    .replace(
      /\x1B\[[0-9;]*[A-Za-z]/g,
      ""
    )
    .replace(/\r/g, "");
}


function getErrorMessage(error) {
  return (
    error.response?.data?.message ||
    error.response?.data?.error ||
    error.message ||
    "Unknown error"
  );
}


function validateCredentials(req, res) {
  const locationId = String(
    req.body.locationId || ""
  ).trim();

  const token = String(
    req.body.token || ""
  ).trim();

  if (!locationId || !token) {
    res.status(400).json({
      success: false,

      message:
        "Location ID and Integration Token are required.",
    });

    return null;
  }

  return {
    locationId,
    token,
  };
}


function runNodeScript(
  scriptName,
  credentials,
  extraEnv = {}
) {
  return new Promise(
    (resolve, reject) => {
      const scriptPath = path.join(
        PROJECT_ROOT,
        scriptName
      );

      const child = spawn(
        process.execPath,
        [scriptPath],
        {
          cwd: PROJECT_ROOT,

          env: {
            ...process.env,

            GHL_LOCATION_ID:
              credentials.locationId,

            GHL_TOKEN:
              credentials.token,

            DRY_RUN: "true",

            BROWSER_DELETE:
              "false",

            ...extraEnv,
          },

          windowsHide: true,
        }
      );

      let stdout = "";
      let stderr = "";

      child.stdout.on(
        "data",
        (data) => {
          stdout += data.toString();
        }
      );

      child.stderr.on(
        "data",
        (data) => {
          stderr += data.toString();
        }
      );

      child.on(
        "error",
        reject
      );

      child.on(
        "close",
        (code) => {
          const cleanOutput =
            cleanTerminalText(stdout);

          const cleanErrors =
            cleanTerminalText(stderr);

          if (
            code !== 0 &&
            !cleanOutput
          ) {
            reject(
              new Error(
                cleanErrors ||
                `${scriptName} exited with code ${code}`
              )
            );

            return;
          }

          resolve({
            code,
            stdout: cleanOutput,
            stderr: cleanErrors,
          });
        }
      );
    }
  );
}


// =====================================================
// RESOURCE DEFINITIONS
// =====================================================

function normalizeKey(label) {
  const map = {
    Location:
      "location",

    Tags:
      "tags",

    "Custom Fields":
      "customFields",

    Contacts:
      "contacts",

    Opportunities:
      "opportunities",

    Calendars:
      "calendars",

    Workflows:
      "workflows",

    Funnels:
      "funnels",

    Pipelines:
      "pipelines",

    Forms:
      "forms",

    Surveys:
      "surveys",

    "URL Redirects":
      "urlRedirects",

    Products:
      "products",

    "Custom Values":
      "customValues",

    "Email/SMS Templates":
      "templates",

    "Trigger Links":
      "triggerLinks",
  };

  return map[label] || null;
}


function createResource(label) {
  return {
    label,
    count: 0,
    items: [],
    status: "unknown",
    error: null,
  };
}


function createEmptyResources() {
  return {
    tags:
      createResource("Tags"),

    customFields:
      createResource(
        "Custom Fields"
      ),

    customValues:
      createResource(
        "Custom Values"
      ),

    calendars:
      createResource(
        "Calendars"
      ),

    workflows:
      createResource(
        "Workflows"
      ),

    funnels:
      createResource(
        "Funnels"
      ),

    forms:
      createResource(
        "Forms"
      ),

    triggerLinks:
      createResource(
        "Trigger Links"
      ),

    contacts:
      createResource(
        "Contacts"
      ),

    opportunities:
      createResource(
        "Opportunities"
      ),

    pipelines:
      createResource(
        "Pipelines"
      ),

    surveys:
      createResource(
        "Surveys"
      ),

    products:
      createResource(
        "Products"
      ),

    templates:
      createResource(
        "Email/SMS Templates"
      ),

    urlRedirects:
      createResource(
        "URL Redirects"
      ),
  };
}


function makeDisplayItemId(
  category,
  position,
  name
) {
  const safeName = String(
    name || ""
  )
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      "-"
    )
    .replace(
      /^-+|-+$/g,
      ""
    )
    .slice(0, 80);

  return `${category}-${position}-${safeName || "item"}`;
}


// =====================================================
// AUDIT OUTPUT PARSER
// =====================================================

function parseAuditOutput(output) {
  const resources =
    createEmptyResources();

  const lines =
    cleanTerminalText(output)
      .split("\n");

  let locationName =
    "Connected GHL Account";

  let activeKey = null;
  let readingList = false;
  let pendingItem = null;


  function savePendingItem() {
    if (
      !pendingItem ||
      !activeKey ||
      !resources[activeKey]
    ) {
      pendingItem = null;
      return;
    }

    const name =
      pendingItem.name
        .replace(
          /\s+/g,
          " "
        )
        .trim();

    if (name) {
      resources[
        activeKey
      ].items.push({
        id:
          makeDisplayItemId(
            activeKey,
            pendingItem.position,
            name
          ),

        position:
          pendingItem.position,

        name,

        type:
          activeKey,

        realId:
          false,
      });
    }

    pendingItem = null;
  }


  for (
    const rawLine of lines
  ) {
    const line =
      rawLine.trim();

    const successMatch =
      line.match(
        /^✅ (.+?): SUCCESS$/
      );

    const failedMatch =
      line.match(
        /^❌ (.+?): FAILED$/
      );


    if (
      successMatch ||
      failedMatch
    ) {
      savePendingItem();

      const label =
        successMatch
          ? successMatch[1]
          : failedMatch[1];

      activeKey =
        normalizeKey(label);

      readingList =
        false;

      if (
        activeKey &&
        resources[activeKey]
      ) {
        resources[
          activeKey
        ].status =
          successMatch
            ? "success"
            : "failed";
      }

      continue;
    }


    if (
      activeKey ===
      "location"
    ) {
      const nameMatch =
        line.match(
          /^Name:\s*(.+)$/
        );

      if (nameMatch) {
        locationName =
          nameMatch[1].trim();
      }

      continue;
    }


    if (
      !activeKey ||
      !resources[activeKey]
    ) {
      continue;
    }


    const countMatch =
      line.match(
        /^Found(?: on first page)?:\s*(\d+)/
      );

    if (countMatch) {
      resources[
        activeKey
      ].count =
        Number(
          countMatch[1]
        );

      continue;
    }


    if (
      /^[A-Z][A-Z /-]+ LIST:$/.test(
        line
      )
    ) {
      savePendingItem();

      readingList = true;

      continue;
    }


    if (
      line ===
        "AUDIT FINISHED" ||
      line ===
        "NOTHING WAS DELETED" ||
      /^={5,}$/.test(line)
    ) {
      savePendingItem();

      readingList = false;

      continue;
    }


    if (!readingList) {
      continue;
    }


    const itemMatch =
      line.match(
        /^(\d+)\.\s+(.+)$/
      );

    if (itemMatch) {
      savePendingItem();

      pendingItem = {
        position:
          Number(
            itemMatch[1]
          ),

        name:
          itemMatch[2].trim(),
      };

      continue;
    }


    if (
      pendingItem &&
      line &&
      !line.startsWith("✅") &&
      !line.startsWith("❌") &&
      !line.startsWith("⚠️")
    ) {
      pendingItem.name +=
        ` ${line}`;
    }
  }


  savePendingItem();


  for (
    const [
      category,
      resource,
    ] of Object.entries(
      resources
    )
  ) {
    const seen =
      new Set();

    resource.items =
      resource.items.filter(
        (item) => {
          const key =
            `${item.position}:${item.name}`;

          if (
            seen.has(key)
          ) {
            return false;
          }

          seen.add(key);

          return true;
        }
      );

    resource.items =
      resource.items.map(
        (
          item,
          index
        ) => ({
          ...item,

          position:
            item.position ||
            index + 1,

          id:
            item.id ||
            makeDisplayItemId(
              category,
              index + 1,
              item.name
            ),
        })
      );

    if (
      resource.items.length >
      resource.count
    ) {
      resource.count =
        resource.items.length;
    }
  }


  return {
    locationName,
    resources,
  };
}


// =====================================================
// TEST CONNECTION
// =====================================================

app.post(
  "/api/test-connection",
  async (req, res) => {
    const credentials =
      validateCredentials(
        req,
        res
      );

    if (!credentials) {
      return;
    }

    try {
      const response =
        await axios.get(
          `https://services.leadconnectorhq.com/locations/${credentials.locationId}`,
          {
            headers: {
              Authorization:
                `Bearer ${credentials.token}`,

              Version:
                "2021-07-28",

              Accept:
                "application/json",
            },

            timeout:
              30000,
          }
        );

      const location =
        response.data.location ||
        response.data;

      res.json({
        success: true,

        location: {
          id:
            location.id ||
            credentials.locationId,

          name:
            location.name ||
            location.business?.name ||
            "Connected GHL Account",
        },
      });
    } catch (error) {
      res
        .status(
          error.response?.status ||
          500
        )
        .json({
          success: false,

          message:
            "Connection failed.",

          details:
            getErrorMessage(
              error
            ),
        });
    }
  }
);


// =====================================================
// SCAN ACCOUNT
// =====================================================

app.post(
  "/api/scan",
  async (req, res) => {
    const credentials =
      validateCredentials(
        req,
        res
      );

    if (!credentials) {
      return;
    }

    try {
      console.log("");
      console.log(
        "=============================="
      );

      console.log(
        `Scanning location: ${credentials.locationId}`
      );

      console.log(
        "=============================="
      );


      const auditResult =
        await runNodeScript(
          "audit.js",
          credentials,
          {
            DRY_RUN:
              "true",

            BROWSER_DELETE:
              "false",
          }
        );


      const parsed =
        parseAuditOutput(
          auditResult.stdout
        );


      /*
        Tags, Custom Fields and Custom Values
        need their real GHL IDs before selected
        deletion can be safely enabled.
      */

      const apiResources =
        await scanApiResources(
          credentials
        );


      for (
        const category of [
          "tags",
          "customFields",
          "customValues",
        ]
      ) {
        const apiResult =
          apiResources[
            category
          ];

        if (!apiResult) {
          continue;
        }

        parsed.resources[
          category
        ].status =
          apiResult.status;

        parsed.resources[
          category
        ].error =
          apiResult.error ||
          null;


        if (
          apiResult.status ===
          "success"
        ) {
          parsed.resources[
            category
          ].items =
            apiResult.items.map(
              (
                item,
                index
              ) => ({
                ...item,

                position:
                  index + 1,

                type:
                  category,

                realId:
                  true,
              })
            );

          parsed.resources[
            category
          ].count =
            apiResult.items.length;
        }
      }


      const totalItems =
        Object.values(
          parsed.resources
        ).reduce(
          (
            total,
            resource
          ) =>
            total +
            resource.items.length,

          0
        );


      console.log(
        `Scan finished: ${parsed.locationName}`
      );

      console.log(
        `Individual items loaded: ${totalItems}`
      );


      res.json({
        success: true,

        location: {
          id:
            credentials.locationId,

          name:
            parsed.locationName,
        },

        resources:
          parsed.resources,

        deletableCategories: [
          "tags",
          "customFields",
          "customValues",
        ],

        summary: {
          categories:
            Object.keys(
              parsed.resources
            ).length,

          individualItems:
            totalItems,
        },
      });
    } catch (error) {
      console.error(
        "Scan error:",
        error
      );

      res
        .status(500)
        .json({
          success: false,

          message:
            "Account scan failed.",

          details:
            getErrorMessage(
              error
            ),
        });
    }
  }
);


// =====================================================
// DELETE ONLY SELECTED ITEMS
// =====================================================

app.post(
  "/api/delete-selected",
  async (req, res) => {
    const credentials =
      validateCredentials(
        req,
        res
      );

    if (!credentials) {
      return;
    }


    const confirmation =
      String(
        req.body.confirmation ||
        ""
      ).trim();


    if (
      confirmation !==
      "DELETE"
    ) {
      res
        .status(400)
        .json({
          success: false,

          message:
            'Type exactly "DELETE" to confirm.',
        });

      return;
    }


    const requestedSelections =
      req.body.selections ||
      {};


    const supportedCategories = [
      "tags",
      "customFields",
      "customValues",
    ];


    const selections = {};

    let totalSelected = 0;


    for (
      const category of
      supportedCategories
    ) {
      const items =
        Array.isArray(
          requestedSelections[
            category
          ]
        )
          ? requestedSelections[
              category
            ]
          : [];


      selections[
        category
      ] =
        items
          .map(
            (item) => ({
              id:
                String(
                  item.id ||
                  ""
                ).trim(),

              name:
                String(
                  item.name ||
                  "Unnamed item"
                ).trim(),
            })
          )
          .filter(
            (item) =>
              item.id
          );


      totalSelected +=
        selections[
          category
        ].length;
    }


    if (
      !totalSelected
    ) {
      res
        .status(400)
        .json({
          success: false,

          message:
            "No supported items were selected. Select Tags, Custom Fields, or Custom Values.",
        });

      return;
    }


    try {
      console.log("");
      console.log(
        "=============================="
      );

      console.log(
        `Deleting ${totalSelected} selected items`
      );

      console.log(
        `Location: ${credentials.locationId}`
      );

      console.log(
        "=============================="
      );


      const result =
        await deleteSelectedApiItems({
          ...credentials,
          selections,
        });


      res.json({
        success:
          result.failed === 0,

        message:
          result.failed === 0
            ? "Selected items deleted successfully."
            : "Cleanup finished with some failures.",

        deleted:
          result.deleted,

        failed:
          result.failed,

        results:
          result.results,
      });
    } catch (error) {
      console.error(
        "Deletion error:",
        error
      );

      res
        .status(500)
        .json({
          success: false,

          message:
            "Selected deletion failed.",

          details:
            getErrorMessage(
              error
            ),
        });
    }
  }
);


// =====================================================
// HEALTH CHECK
// =====================================================

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,
      status: "running",
      port: PORT,
    });
  }
);


// =====================================================
// START SERVER
// =====================================================

app.listen(
  PORT,
  () => {
    console.log("");
    console.log(
      "=============================="
    );

    console.log(
      "GHL CLEANUP WEB ENGINE"
    );

    console.log(
      "=============================="
    );

    console.log(
      `Open: http://localhost:${PORT}`
    );

    console.log(
      "Mode: selected deletion enabled"
    );

    console.log(
      "=============================="
    );
  }
);