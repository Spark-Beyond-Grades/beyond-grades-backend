const express = require("express");
const router = express.Router();

const Authority = require("../models/Authority");
const { admin, initFirebaseAdmin } = require("../config/firebaseAdmin");

initFirebaseAdmin();

router.post("/sync", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split("Bearer ")[1]
      : null;

    if (!token) {
      return res.status(401).json({ ok: false, message: "Missing Bearer token" });
    }

    // 1) Verify Firebase ID token
    const decoded = await admin.auth().verifyIdToken(token);

    const email = (decoded.email || "").toLowerCase();
    const name = decoded.name || decoded.displayName || "";

    if (!email) {
      return res.status(400).json({ ok: false, message: "No email found in token" });
    }

    // 2) Check allowlist in MongoDB
    const authority = await Authority.findOne({ email });

    if (!authority || authority.isActive === false) {
      return res.status(403).json({ ok: false, message: "Access denied" });
    }

    // 3) Return authority profile
    return res.json({
      ok: true,
      authority: {
        id: authority._id,
        email: authority.email,
        name: authority.name || name,
        role: authority.role,
        isActive: authority.isActive,
      },
    });
  } catch (err) {
    console.error("❌ /auth/sync error:", err.message);
    return res.status(401).json({ ok: false, message: "Invalid or expired token" });
  }
});

module.exports = router;