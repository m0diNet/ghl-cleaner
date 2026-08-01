require("dotenv").config();
const axios = require("axios");

const GHL_TOKEN = process.env.GHL_TOKEN;

if (!GHL_TOKEN) {
  throw new Error("Missing GHL_TOKEN in .env");
}

const ghl = axios.create({
  baseURL: "https://services.leadconnectorhq.com",
  headers: {
    Authorization: `Bearer ${GHL_TOKEN}`,
    Version: "2021-07-28",
    Accept: "application/json",
  },
});

module.exports = ghl;