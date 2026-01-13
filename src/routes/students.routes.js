const router = require("express").Router();
const { syncStudent, updateProfile } = require("../controllers/student.controller");

// POST /students/sync
router.post("/sync", syncStudent);
router.post("/profile", updateProfile);

module.exports = router;