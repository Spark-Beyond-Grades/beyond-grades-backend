const assert = require("assert");
const test = require("node:test");

const { loadServiceAccount } = require("./firebaseAdmin");

test("loadServiceAccount reads base64 encoded Firebase service account JSON", () => {
  const original = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const serviceAccount = {
    project_id: "beyond-grades",
    client_email: "firebase-admin@example.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  };

  try {
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = Buffer.from(
      JSON.stringify(serviceAccount),
      "utf8"
    ).toString("base64");

    assert.deepStrictEqual(loadServiceAccount(), serviceAccount);
  } finally {
    if (original === undefined) {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    } else {
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = original;
    }
  }
});
