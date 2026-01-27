const router = require("express").Router();
const requireStudent = require("../middleware/requireStudent");
const { syncStudent,getEventDetail, updateProfile, getEventTeam, submitEventFeedback } = require("../controllers/student.controller");

// POST /students/sync
router.post("/sync", syncStudent);

// POST /students/profile
router.post("/profile", updateProfile);

// GET /students/events/:eventId 
router.get("/events/:eventId", requireStudent, getEventDetail);

// GET /students/events/:eventId/team
router.get("/events/:eventId/team", requireStudent, getEventTeam);

// POST /students/events/:eventId/feedback/submit
router.post("/events/:eventId/feedback/submit", requireStudent, submitEventFeedback);

module.exports = router;