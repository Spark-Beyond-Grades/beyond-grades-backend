const admin = require("firebase-admin");

let initialized = false;

function initFirebaseAdmin() {
  if (initialized) return;

  // local dev: load JSON from file
  const serviceAccount = require("./firebaseAdmin.json");

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  initialized = true;
}

module.exports = { admin, initFirebaseAdmin };