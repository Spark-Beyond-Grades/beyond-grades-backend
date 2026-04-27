const { admin, initFirebaseAdmin } = require("../config/firebaseAdmin");

initFirebaseAdmin();

async function requireStudent(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split("Bearer ")[1]
      : null;

    if (!token) {
      return res.status(401).json({ ok: false, message: "Missing Bearer token" });
    }

    const decoded = await admin.auth().verifyIdToken(token);

    const uid = decoded.uid;
    const email = (decoded.email || "").toLowerCase();

    if (!uid) {
      return res.status(401).json({ ok: false, message: "Invalid token" });
    }

    // attach minimal identity (no DB access here)
    req.user = {
      uid,
      email,
      name: decoded.name || decoded.displayName || "",
      provider: decoded.firebase?.sign_in_provider || decoded.sign_in_provider || "firebase",
    };

    next();
  } catch (err) {
    console.error("❌ requireStudent:", err.message);
    return res.status(401).json({ ok: false, message: "Invalid or expired token" });
  }
}

module.exports = requireStudent;
