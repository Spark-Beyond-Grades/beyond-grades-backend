const crypto = require("node:crypto");

function createShareToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashShareToken(token) };
}

function hashShareToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

module.exports = { createShareToken, hashShareToken };
