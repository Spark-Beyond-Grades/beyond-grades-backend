const express = require("express");
const router = express.Router();
const requireStudent = require("../middleware/requireStudent");

const {
  searchUniversities,
  ensureUniversity
} = require("../controllers/universities.controller");

router.get("/search", searchUniversities);
router.post("/ensure", requireStudent, ensureUniversity);

module.exports = router;
