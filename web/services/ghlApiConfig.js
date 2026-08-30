const BASE_URL = "https://services.leadconnectorhq.com";
const API_VERSION = "v3";

function createGhlClient(token, axiosCreate) {
  const factory = axiosCreate || require("axios").create;
  return factory({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Version: API_VERSION,
    },
  });
}

module.exports = {
  API_VERSION,
  BASE_URL,
  createGhlClient,
};
