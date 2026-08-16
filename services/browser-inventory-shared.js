function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return cleanText(value).toLowerCase();
}

function isHeaderText(value) {
  return /^(name|status|updated on|last updated|created on|home|stats|actions?)$/i.test(
    cleanText(value)
  );
}

function isPlaceholderText(category, value) {
  const text = normalizeText(value);

  if (!text) {
    return false;
  }

  const generic = [
    /no .* found/i,
    /no records/i,
    /no data/i,
    /nothing here/i,
    /start by creating/i,
    /create your first/i,
  ];

  const categorySpecific = {
    workflows: [/no workflows/i, /nothing here/i, /start by creating/i],
    funnels: [
      /no funnels/i,
      /create a funnel/i,
      /all your funnels and folders will live here/i,
    ],
    forms: [
      /no forms/i,
      /create a form/i,
      /all your forms and folders will live here/i,
    ],
  };

  return [...generic, ...(categorySpecific[category] || [])].some((pattern) =>
    pattern.test(text)
  );
}

const HEADER_TEXT_PATTERNS = {
  workflows: [
    /^name$/i,
    /^status$/i,
    /^last updated$/i,
    /^created on$/i,
    /^updated on$/i,
    /^actions?$/i,
    /^stats?$/i,
    /^owner$/i,
    /^active enrolled$/i,
    /^total enrolled$/i,
  ],
  funnels: [/^name$/i, /^last updated$/i, /^funnel steps$/i],
  forms: [/^name$/i, /^updated on$/i, /^updated by$/i],
};

function splitRowText(value) {
  return cleanText(value)
    .split(/[\n|]/g)
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function looksLikeHeaderOnlyRow(category, value) {
  const lines = splitRowText(value);

  if (!lines.length) {
    return false;
  }

  const patterns = HEADER_TEXT_PATTERNS[category] || [];
  return lines.every((line) => patterns.some((pattern) => pattern.test(line)));
}

function rowLooksLikeFolder(category, value) {
  const text = cleanText(value);

  if (category === "funnels" || category === "forms") {
    return (
      /\b\d+\s+(funnels|forms)\b/i.test(text) ||
      /folder\b/i.test(text) ||
      /^\.+\d+\.\d+\s*\|\s*/.test(text)
    );
  }

  return /folder/i.test(text);
}

function normalizeSignatureText(value) {
  return cleanText(value)
    .replace(
      /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*\s+\d{1,2},\s+\d{4}.*$/i,
      ""
    )
    .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)\b/gi, "")
    .replace(/\b\d+\s+(?:funnels|forms|step|steps)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function looksLikeActionCandidate(candidate) {
  const joined = [
    candidate.ariaLabel,
    candidate.title,
    candidate.dataTestId,
    candidate.ariaHaspopup,
    candidate.text,
  ]
    .map(cleanText)
    .join(" ")
    .toLowerCase();

  return (
    candidate.ariaHaspopup === "menu" ||
    /more|menu|action|ellipsis|dots|options|overflow|three/i.test(joined)
  );
}

function stripDisplayMetadata(value) {
  return cleanText(value)
    .replace(
      /\s*-\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*\s+\d{1,2}(?:,)?\s+\d{4}.*$/i,
      ""
    )
    .replace(
      /\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*\s+\d{1,2}(?:,)?\s+\d{4}.*$/i,
      ""
    )
    .replace(/\s+\d{1,2}:\d{2}\s*(?:am|pm)\b.*$/i, "")
    .replace(/\s+\d+\s+(?:funnels|forms|step|steps)\b.*$/i, "")
    .replace(/\s+updated\s+by\b.*$/i, "")
    .replace(/\s+updated\s+on\b.*$/i, "")
    .replace(/\s+last\s+updated\b.*$/i, "")
    .trim();
}

function canonicalizeRowNameFromText(value) {
  return stripDisplayMetadata(value);
}

async function isVisible(locator) {
  return locator.isVisible().catch(() => false);
}

async function findRowActionCandidate(row) {
  const lastCell = row.locator("xpath=./*").last();

  if (!(await isVisible(lastCell))) {
    return null;
  }

  const candidates = lastCell.locator(
    'button, [role="button"], [aria-haspopup], [data-testid], a[href]'
  );
  const count = await candidates.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);

    if (!(await isVisible(candidate))) {
      continue;
    }

    const info = {
      tagName: cleanText(
        await candidate.evaluate((node) => node.tagName).catch(() => "")
      ).toLowerCase(),
      role: cleanText(await candidate.getAttribute("role").catch(() => "")),
      ariaLabel: cleanText(await candidate.getAttribute("aria-label").catch(() => "")),
      title: cleanText(await candidate.getAttribute("title").catch(() => "")),
      dataTestId: cleanText(await candidate.getAttribute("data-testid").catch(() => "")),
      ariaHaspopup: cleanText(await candidate.getAttribute("aria-haspopup").catch(() => "")),
      text: cleanText(await candidate.innerText().catch(() => "")),
    };

    if (looksLikeActionCandidate(info)) {
      return { candidate, info };
    }
  }

  return null;
}

async function openInventoryRowLikeInspector(row, page) {
  const link = row.locator("a[href]").first();
  if (await isVisible(link)) {
    await link.click({ timeout: 5000 }).catch(() => {});
    return true;
  }

  const button = row.locator('button, [role="button"], [aria-haspopup]').first();
  if (await isVisible(button)) {
    await button.click({ timeout: 5000 }).catch(() => {});
    return true;
  }

  await row.click({ timeout: 5000 }).catch(() => {});
  return true;
}

async function extractCanonicalRowName(row, category = "") {
  const rowText = cleanText(await row.innerText().catch(() => ""));

  if (!rowText) {
    return "";
  }

  const directCandidates = await row
    .locator("xpath=./*")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => String(node.innerText || node.textContent || ""))
        .filter(Boolean)
    )
    .catch(() => []);

  const nestedCandidates = await row
    .locator('a[href], [role="link"], [aria-label], [title], [data-testid]')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => String(node.innerText || node.textContent || node.getAttribute("aria-label") || node.getAttribute("title") || node.getAttribute("data-testid") || ""))
        .filter(Boolean)
    )
    .catch(() => []);

  const candidates = [
    ...nestedCandidates,
    ...directCandidates,
    rowText,
  ]
    .map((text) => cleanText(text))
    .map((text) => canonicalizeRowNameFromText(text))
    .filter((text) => text && !isHeaderText(text) && !isPlaceholderText(category, text))
    .filter(Boolean);

  if (!candidates.length) {
    return rowText;
  }

  const best = candidates
    .sort((a, b) => {
      const score = (text) => {
        let value = text.length;
        if (/\b\d+\s+(funnels|forms|step|steps)\b/i.test(text)) value -= 60;
        if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*\s+\d{1,2}/i.test(text)) value -= 40;
        if (/^[.]+\d+\.\d+\s*\|/.test(text)) value += 10;
        if (/\|/.test(text)) value += 5;
        return value;
      };

      return score(b) - score(a);
    })[0];

  return best || rowText;
}

function getInventoryRowSelectors() {
  return [
    "table tbody tr",
    '[role="row"]',
    '[aria-rowindex]',
    '[data-row-index]',
    '[data-index]',
    '[role="listitem"]',
  ];
}

function getActionMenuSelectors(category) {
  if (category === "workflows") {
    return [
      '[aria-label="Workflow list actions"]',
      '[aria-label*="workflow list actions" i]',
      '[aria-label*="action" i]',
      'button[aria-haspopup="menu"]',
      '[role="button"][aria-haspopup="menu"]',
    ];
  }

  return [
    '[aria-label*="action" i]',
    '[aria-label*="more" i]',
    '[aria-label*="menu" i]',
    '[data-testid*="action" i]',
    '[data-testid*="more" i]',
    'button[aria-haspopup="menu"]',
    '[role="button"][aria-haspopup="menu"]',
  ];
}

module.exports = {
  cleanText,
  findRowActionCandidate,
  extractCanonicalRowName,
  getActionMenuSelectors,
  getInventoryRowSelectors,
  isHeaderText,
  isPlaceholderText,
  looksLikeActionCandidate,
  looksLikeHeaderOnlyRow,
  normalizeSignatureText,
  normalizeText,
  canonicalizeRowNameFromText,
  openInventoryRowLikeInspector,
  rowLooksLikeFolder,
};
