const express = require("express");
const router = express.Router();

// Public endpoint (no auth)
router.get("/version", async (req, res) => {
  return res.json({
    latestBuild: 8  ,
    minSupportedBuild: 1,
    message: "New event templates added",
    playStoreUrl: "market://details?id=roy.ij.beyondgrades"
  });
});

module.exports = router;