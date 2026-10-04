const router = require("express").Router();
const requireStudent = require("../middleware/requireStudent");
const upload = require("../middleware/uploadPhoto");
const { syncStudent,getEventDetail,uploadStudentPhoto , updateProfile, getEventTeam, submitEventFeedback, getStudentDashboard, getDashboardPrivacy, updateDashboardPrivacy, rotateDashboardShareToken, revokeDashboardShareToken, getPublicDashboardProfile, getLeaderboard, registerForEvent } = require("../controllers/student.controller");

// GET /students/dashboard
router.get("/dashboard", requireStudent, getStudentDashboard);
router.get("/leaderboard", requireStudent, getLeaderboard);
router.post("/events/:eventId/register", requireStudent, registerForEvent);
router.get("/dashboard/privacy", requireStudent, getDashboardPrivacy);
router.put("/dashboard/privacy", requireStudent, updateDashboardPrivacy);
router.post("/dashboard/share-token/rotate", requireStudent, rotateDashboardShareToken);
router.post("/dashboard/share-token/revoke", requireStudent, revokeDashboardShareToken);
router.get("/dashboard/public/:token", getPublicDashboardProfile);

// POST /students/sync
router.post("/sync", requireStudent, syncStudent);

// POST /students/profile
router.post("/profile", requireStudent, updateProfile);

// GET /students/events/:eventId 
router.get("/events/:eventId", requireStudent, getEventDetail);

// GET /students/events/:eventId/team
router.get("/events/:eventId/team", requireStudent, getEventTeam);

// POST /students/events/:eventId/feedback/submit
router.post("/events/:eventId/feedback/submit", requireStudent, submitEventFeedback);

// POST /students/photo
router.post("/photo", requireStudent, upload.single("photo"), uploadStudentPhoto);

module.exports = router;
