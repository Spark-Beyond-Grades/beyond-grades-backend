const express = require("express");
const router = express.Router();

const requireAuthority = require("../middleware/requireAuthority");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

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
} = require("../controllers/events.controller");

// Public route
router.get("/feed", getStudentFeed);

// All routes below require allowlisted authority
router.use(requireAuthority);

router.post("/", createDraftEvent);
router.get("/", listEvents);
router.put("/:id", updateEvent);
router.post("/:id/poster", upload.single("poster"), uploadEventPoster);

router.get("/:id/participants", getParticipants);
router.post("/:id/participants/upload", upload.single("file"), uploadParticipantsCsv);

router.post("/:id/publish", publishEvent);
router.get("/:id", getEventById);
router.post("/:id/close", closeEvent);

module.exports = router;