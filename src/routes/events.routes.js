const express = require("express");
const router = express.Router();

const requireAuthority = require("../middleware/requireAuthority");
const Event = require("../models/Event");
const { computeEffectiveStatus } = require("../utils/eventStatus");

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
