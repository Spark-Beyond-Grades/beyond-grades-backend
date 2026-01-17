const express = require("express");
const router = express.Router();

const {
  searchUniversities,
  ensureUniversity
} = require("../controllers/universities.controller");

router.get("/search", searchUniversities);
router.post("/ensure", ensureUniversity);

module.exports = router;