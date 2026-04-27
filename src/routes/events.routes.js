const express = require("express");
const router = express.Router();

const requireAuthority = require("../middleware/requireAuthority");
const requireStudent = require("../middleware/requireStudent");
const multer = require("multer");
const storage = multer.memoryStorage();
const imageUpload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return callback(new Error("Only JPEG, PNG, and WebP images are allowed"));
    }
    return callback(null, true);
  },
});
const csvUpload = multer({
  storage,
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (!["text/csv", "application/vnd.ms-excel"].includes(file.mimetype)) {
      return callback(new Error("Only CSV files are allowed"));
    }
    return callback(null, true);
  },
});

const {
  getStudentFeed,
  createDraftEvent,
  listEvents,
  updateEvent,
  getParticipants,
  uploadParticipantsCsv,
  publishEvent,
  getEventById,
  closeEvent,
  uploadEventPoster,
  uploadEventLogo,
  getFeedbackSummary,
  getSuggestions,
} = require("../controllers/events.controller");

// Student route
router.get("/feed", requireStudent, getStudentFeed);

// All routes below require allowlisted authority
router.use(requireAuthority);

router.post("/", createDraftEvent);
router.get("/", listEvents);
router.get("/suggestions", getSuggestions);

// ⚠️ Must be BEFORE /:id routes to avoid 'feedback-summary' being parsed as an ID
router.get("/feedback-summary", getFeedbackSummary);

router.put("/:id", updateEvent);
router.post("/:id/poster", imageUpload.single("poster"), uploadEventPoster);
router.post("/:id/logo", imageUpload.single("logo"), uploadEventLogo);

router.get("/:id/participants", getParticipants);
router.post("/:id/participants/upload", csvUpload.single("file"), uploadParticipantsCsv);

router.post("/:id/publish", publishEvent);
router.get("/:id", getEventById);
router.post("/:id/close", closeEvent);

module.exports = router;
