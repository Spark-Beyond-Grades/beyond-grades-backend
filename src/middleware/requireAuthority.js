const Authority = require("../models/Authority");
const { sameStoredEmail } = require("../utils/emailQuery");
const { admin, initFirebaseAdmin } = require("../config/firebaseAdmin");

initFirebaseAdmin();

async function requireAuthority(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split("Bearer ")[1]
      : null;

    if (!token) return res.status(401).json({ ok: false, message: "Missing Bearer token" });

    const decoded = await admin.auth().verifyIdToken(token);

    const email = (decoded.email || "").toLowerCase();
    if (!email) return res.status(400).json({ ok: false, message: "No email in token" });

    const authority = await Authority.findOne(sameStoredEmail("$email", email));
    if (!authority || authority.isActive === false) {
      return res.status(403).json({ ok: false, message: "Access denied" });
    }
    if (!authority.groupId) {
      return res.status(403).json({ ok: false, message: "Authority groupId not set" });
    }

    // attach useful info for routes
    req.user = {
      email,
      name: decoded.name || decoded.displayName || "",
      role: authority.role,
      authorityId: authority._id,
      groupId: authority.groupId,
    };

    next();
  } catch (err) {
    console.error("❌ requireAuthority:", err.message);
    return res.status(401).json({ ok: false, message: "Invalid or expired token" });
  }
}

module.exports = requireAuthority;
