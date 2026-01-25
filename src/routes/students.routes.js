const router = require("express").Router();
const requireStudent = require("../middleware/requireStudent");
const { syncStudent,getEventDetail, updateProfile } = require("../controllers/student.controller");

// POST /students/sync
router.post("/sync", syncStudent);
router.post("/profile", updateProfile);
// GET /students/events/:eventId 
router.get("/events/:eventId", requireStudent, getEventDetail);

module.exports = router;