const University = require("../models/University");

exports.searchUniversities = async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ items: [] });

    const items = await University.find({
      name: { $regex: q, $options: "i" }
    })
      .sort({ name: 1 })
      .limit(10)
      .select("_id name");

    return res.json({
      items: items.map(u => ({ id: u._id.toString(), name: u.name }))
    });
  } catch (err) {
    console.error("searchUniversities error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.ensureUniversity = async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ message: "name is required" });

    // Case-insensitive exact match check
    let uni = await University.findOne({ name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } });

    if (!uni) {
      uni = await University.create({ name });
    }

    return res.status(200).json({ id: uni._id.toString(), name: uni.name });
  } catch (err) {
    // handle duplicate key race condition
    if (err.code === 11000) {
      const name = (req.body.name || "").trim();
      const uni = await University.findOne({ name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } });
      if (uni) return res.status(200).json({ id: uni._id.toString(), name: uni.name });
    }

    console.error("ensureUniversity error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}