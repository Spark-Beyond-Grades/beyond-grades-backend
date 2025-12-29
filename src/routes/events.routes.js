const express = require("express");
const router = express.Router();

const requireAuthority = require("../middleware/requireAuthority");
const Event = require("../models/Event");
const { computeEffectiveStatus } = require("../utils/eventStatus");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const Participant = require("../models/Participant");

const upload = multer({ storage: multer.memoryStorage() });

// All routes below require allowlisted authority
router.use(requireAuthority);

/**
 * POST /events
 * Creates a minimal DRAFT event.
 * Body (optional): { name, type, description }
 */
router.post("/", async (req, res) => {
  try {
    const { name = "", type = "OTHER", description = "" } = req.body || {};

    const event = await Event.create({
      name,
      type,
      description,
      createdByEmail: req.user.email,
      status: "DRAFT",
    });

    return res.status(201).json({
      ok: true,
      event: {
        ...event.toObject(),
        effectiveStatus: computeEffectiveStatus(event),
      },
    });
  } catch (err) {
    console.error("❌ POST /events:", err.message);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to create event" });
  }
});

/**
 * GET /events
 * Returns all events + computed effectiveStatus.
 */
router.get("/", async (req, res) => {
  try {
    const events = await Event.find().sort({ createdAt: -1 });

    const mapped = events.map((e) => ({
      ...e.toObject(),
      effectiveStatus: computeEffectiveStatus(e),
    }));

    return res.json({ ok: true, events: mapped });
  } catch (err) {
    console.error("❌ GET /events:", err.message);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to fetch events" });
  }
});

/**
 * PUT /events/:id
 * Update draft event info: name, type, description.
 */
router.put("/:id", async (req, res) => {
  try {
    const {
      name,
      type,
      description,
      openAt,
      closeAtTentative,
      levels,
      committees,
      skills,
    } = req.body || {};

    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ ok: false, message: "Event not found" });
    }

    // Phase 3 rule: cannot edit closed events
    if (event.status === "CLOSED" || event.closeAtActual) {
      return res.status(400).json({
        ok: false,
        message: "Event is closed and cannot be edited",
      });
    }

    if (typeof name === "string") {
      event.name = name.trim();
    }

    if (typeof description === "string") {
      event.description = description.trim();
    }

    if (typeof type === "string") {
      const allowed = ["CLUB", "PROJECT", "FEST", "COMMITTEE", "OTHER"];
      if (!allowed.includes(type)) {
        return res.status(400).json({
          ok: false,
          message: "Invalid event type",
        });
      }
      event.type = type;
    }

    // Dates (ISO strings expected from frontend)
    if (openAt !== undefined) {
      event.openAt = openAt ? new Date(openAt) : null;
    }
    if (closeAtTentative !== undefined) {
      event.closeAtTentative = closeAtTentative
        ? new Date(closeAtTentative)
        : null;
    }

    // validate open < close (only when both exist)
    if (event.openAt && event.closeAtTentative) {
      if (event.openAt >= event.closeAtTentative) {
        return res.status(400).json({
          ok: false,
          message: "Invalid dates: openAt must be before closeAtTentative",
        });
      }
    }

    // Step 3.3 - levels update
    if (Array.isArray(levels)) {
      const cleanedLevels = levels
        .map((l) => (typeof l === "string" ? l.trim() : ""))
        .filter(Boolean);

      event.levels = [...new Set(cleanedLevels)];
    }

    // Step 3.3 - committees update
    if (Array.isArray(committees)) {
      const cleanedCommittees = committees
        .map((c) => {
          const name = typeof c?.name === "string" ? c.name.trim() : "";
          const allowedLevels = Array.isArray(c?.allowedLevels)
            ? c.allowedLevels
                .map((l) => (typeof l === "string" ? l.trim() : ""))
                .filter(Boolean)
            : [];
          return { name, allowedLevels };
        })
        .filter((c) => c.name);

      // validate allowedLevels exist in event.levels (if levels exist)
      const levelsSet = new Set(event.levels || []);
      for (const c of cleanedCommittees) {
        for (const lv of c.allowedLevels) {
          if (event.levels?.length && !levelsSet.has(lv)) {
            return res.status(400).json({
              ok: false,
              message: `Invalid mapping: level "${lv}" not present in levels[]`,
            });
          }
        }
      }

      event.committees = cleanedCommittees;
    }

    // skills update
    if (Array.isArray(skills)) {
      const cleanedSkills = skills
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter(Boolean);

      event.skills = [...new Set(cleanedSkills)];
    }

    await event.save();

    return res.json({
      ok: true,
      event: {
        ...event.toObject(),
        effectiveStatus: computeEffectiveStatus(event),
      },
    });
  } catch (err) {
    console.error("❌ PUT /events/:id:", err.message);
    return res.status(500).json({
      ok: false,
      message: "Failed to update event",
    });
  }
});

router.get("/:id/participants", async (req, res) => {
  try {
    const participants = await Participant.find({ eventId: req.params.id }).sort({
      createdAt: -1,
    });
    return res.json({ ok: true, participants });
  } catch (err) {
    console.error("❌ GET /events/:id/participants:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to fetch participants" });
  }
});

router.post("/:id/participants/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "CSV file is required" });
    }

    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });

    const csvText = req.file.buffer.toString("utf-8");

    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ ok: false, message: "CSV has no rows" });
    }

    const validCommittees = new Set((event.committees || []).map((c) => c.name));
    const validLevels = new Set(event.levels || []);

    const errors = [];
    const seenEmails = new Set();
    const docs = [];

    for (let i = 0; i < records.length; i++) {
      const row = records[i] || {};

      const name = (row.name || row.Name || "").toString().trim();
      const email = (row.email || row.Email || "").toString().trim().toLowerCase();
      const rollNumber = (row.rollNumber || row.RollNumber || row.roll || row.Roll || "").toString().trim();
      const committee = (row.committee || row.Committee || "").toString().trim();
      const level = (row.level || row.Level || "").toString().trim();
      const position = (row.position || row.Position || "").toString().trim();

      if (!email) {
        errors.push({ row: i + 2, field: "email", message: "Missing email" });
        continue;
      }

      if (seenEmails.has(email)) {
        errors.push({ row: i + 2, field: "email", message: "Duplicate email in CSV" });
        continue;
      }
      seenEmails.add(email);

      if (committee && validCommittees.size > 0 && !validCommittees.has(committee)) {
        errors.push({ row: i + 2, field: "committee", message: `Unknown committee "${committee}"` });
        continue;
      }

      if (level && validLevels.size > 0 && !validLevels.has(level)) {
        errors.push({ row: i + 2, field: "level", message: `Unknown level "${level}"` });
        continue;
      }

      docs.push({
        eventId: event._id,
        name,
        email,
        rollNumber,
        committee,
        level,
        position,
      });
    }

    if (errors.length > 0) {
      return res.status(400).json({
        ok: false,
        message: "CSV validation failed",
        errors,
      });
    }

    const ops = docs.map((d) => ({
      updateOne: {
        filter: { eventId: d.eventId, email: d.email },
        update: { $setOnInsert: d },
        upsert: true,
      },
    }));

    const result = await Participant.bulkWrite(ops, { ordered: false });

    return res.json({
      ok: true,
      inserted: result.upsertedCount || 0,
      total: docs.length,
    });
  } catch (err) {
    console.error("❌ POST /events/:id/participants/upload:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to upload participants" });
  }
});

router.post("/:id/publish", async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });

    // already closed
    if (event.status === "CLOSED" || event.closeAtActual) {
      return res.status(400).json({ ok: false, message: "Event is closed and cannot be published" });
    }

    // validations
    if (!event.name || !event.name.trim()) {
      return res.status(400).json({ ok: false, message: "Event name is required before publish" });
    }

    if (!event.openAt || !event.closeAtTentative) {
      return res.status(400).json({ ok: false, message: "Feedback window (open/close) is required before publish" });
    }

    if (new Date(event.openAt) >= new Date(event.closeAtTentative)) {
      return res.status(400).json({ ok: false, message: "Invalid feedback window: open must be before close" });
    }

    if (!Array.isArray(event.skills) || event.skills.length === 0) {
      return res.status(400).json({ ok: false, message: "At least 1 skill is required before publish" });
    }

    const participantsCount = await Participant.countDocuments({ eventId: event._id });
    if (participantsCount === 0) {
      return res.status(400).json({ ok: false, message: "At least 1 participant is required before publish" });
    }

    // publish
    event.status = "PUBLISHED";
    await event.save();

    return res.json({
      ok: true,
      message: "Event published successfully",
      event: {
        ...event.toObject(),
        participantsCount,
        effectiveStatus: computeEffectiveStatus(event),
      },
    });
  } catch (err) {
    console.error("❌ POST /events/:id/publish:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to publish event" });
  }
});

/**
 * GET /events/:id
 * Returns one event + computed effectiveStatus.
 */
router.get("/:id", async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event)
      return res.status(404).json({ ok: false, message: "Event not found" });

    return res.json({
      ok: true,
      event: {
        ...event.toObject(),
        effectiveStatus: computeEffectiveStatus(event),
      },
    });
  } catch (err) {
    console.error("❌ GET /events/:id:", err.message);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to fetch event" });
  }
});

module.exports = router;
