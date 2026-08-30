const GHL_API_VERSION = "v3";

function buildGhlHeaders(token, extraHeaders = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    Version: GHL_API_VERSION,
    ...extraHeaders,
  };
}

module.exports = {
  GHL_API_VERSION,
  buildGhlHeaders,
};
