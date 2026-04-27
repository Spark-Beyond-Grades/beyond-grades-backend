const Event = require("../models/Event");
const Participant = require("../models/Participant");
const Authority = require("../models/Authority");
const Student = require("../models/Student");
const { computeEffectiveStatus } = require("../utils/eventStatus");
const { mapEventForStudentFeed } = require("../utils/eventFeed");
const { parse } = require("csv-parse/sync");

// GET /events/feed?uid=FIREBASE_UID
exports.getStudentFeed = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(400).json({ ok: false, message: "uid is required" });

    const student = await Student.findOne({ uid });
    if (!student || !student.universityId) {
      return res.status(400).json({ ok: false, message: "Student university not set" });
    }

    const events = await Event.find({
      status: "PUBLISHED",
    })
      .sort({ createdAt: -1 })
      .limit(50);

    const studentUniversityId = student.universityId.toString();
    const mapped = events.map((e) => mapEventForStudentFeed(e, studentUniversityId));

    return res.json({ ok: true, studentUniversityId, items: mapped });
  } catch (err) {
    console.error("❌ getStudentFeed:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to fetch feed" });
  }
};

// POST /events
exports.createDraftEvent = async (req, res) => {
  try {
    const { name = "", type = "OTHER", description = "", templateId = "T1", minAppBuild = 1 } = req.body || {};

    const authority = await Authority.findOne({ email: req.user.email });
    if (!authority) return res.status(403).json({ ok: false, message: "Not an authority" });

    if (!authority.universityId) {
      return res.status(400).json({ ok: false, message: "Authority university not set" });
    }

    const event = await Event.create({
      name,
      type,
      description,
      createdByEmail: req.user.email,
      groupId: req.user.groupId,
      universityId: authority.universityId,
      universityName: authority.universityName ?? null,
      templateId,
      minAppBuild,
      status: "DRAFT",
    });

    return res.status(201).json({
      ok: true,
      event: { ...event.toObject(), effectiveStatus: computeEffectiveStatus(event) },
    });
  } catch (err) {
    console.error("❌ createDraftEvent:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to create event" });
  }
};

// GET /events
exports.listEvents = async (req, res) => {
  try {
    const events = await Event.find({
      groupId: req.user.groupId,
      status: "PUBLISHED",
    }).sort({ createdAt: -1 });

    const mapped = events.map((e) => ({
      ...e.toObject(),
      effectiveStatus: computeEffectiveStatus(e),
    }));

    return res.json({ ok: true, events: mapped });
  } catch (err) {
    console.error("❌ listEvents:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to fetch events" });
  }
};

// PUT /events/:id
exports.updateEvent = async (req, res) => {
  try {
    const { name, type, description, eventStartDate, eventEndDate, venue, openAt, closeAtTentative, levels, committees, skills, posterUrl, logoUrl } =
      req.body || {};

    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId });
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });

    if (event.status === "CLOSED" || event.closeAtActual) {
      return res.status(400).json({ ok: false, message: "Event is closed and cannot be edited" });
    }

    if (typeof name === "string") event.name = name.trim();
    if (typeof description === "string") event.description = description.trim();
    if (typeof venue === "string") event.venue = venue.trim();
    if (eventStartDate !== undefined) {
      event.eventStartDate = eventStartDate ? new Date(eventStartDate) : null;
      event.eventDate = event.eventStartDate; // Mirror to old field for database views
    }
    if (eventEndDate !== undefined) event.eventEndDate = eventEndDate ? new Date(eventEndDate) : null;

    if (typeof type === "string") {
      const allowed = ["CLUB", "PROJECT", "FEST", "COMMITTEE", "OTHER"];
      if (!allowed.includes(type)) {
        return res.status(400).json({ ok: false, message: "Invalid event type" });
      }
      event.type = type;
    }

    if (posterUrl !== undefined) event.posterUrl = posterUrl;
    if (logoUrl !== undefined) event.logoUrl = logoUrl;

    if (openAt !== undefined) event.openAt = openAt ? new Date(openAt) : null;
    if (closeAtTentative !== undefined)
      event.closeAtTentative = closeAtTentative ? new Date(closeAtTentative) : null;

    if (event.openAt && event.closeAtTentative && event.openAt >= event.closeAtTentative) {
      return res.status(400).json({
        ok: false,
        message: "Invalid dates: openAt must be before closeAtTentative",
      });
    }

    if (Array.isArray(levels)) {
      const cleanedLevels = levels
        .map((l) => (typeof l === "string" ? l.trim() : ""))
        .filter(Boolean);
      event.levels = [...new Set(cleanedLevels)];
    }

    if (Array.isArray(committees)) {
      const cleanedCommittees = committees
        .map((c) => {
          const cname = typeof c?.name === "string" ? c.name.trim() : "";
          const allowedLevels = Array.isArray(c?.allowedLevels)
            ? c.allowedLevels
              .map((l) => (typeof l === "string" ? l.trim() : ""))
              .filter(Boolean)
            : [];
          return { name: cname, allowedLevels };
        })
        .filter((c) => c.name);

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

    if (Array.isArray(skills)) {
      const cleanedSkills = skills
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter(Boolean);
      event.skills = [...new Set(cleanedSkills)];
    }

    await event.save();

    return res.json({
      ok: true,
      event: { ...event.toObject(), effectiveStatus: computeEffectiveStatus(event) },
    });
  } catch (err) {
    console.error("❌ updateEvent:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to update event" });
  }
};

// GET /events/:id/participants
exports.getParticipants = async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId });
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });

    const participants = await Participant.find({ eventId: event._id }).sort({ createdAt: -1 });
    return res.json({ ok: true, participants });
  } catch (err) {
    console.error("❌ getParticipants:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to fetch participants" });
  }
};

// POST /events/:id/participants/upload
exports.uploadParticipantsCsv = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "CSV file is required" });

    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId });
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
      const rollNumber = (row.rollNumber || row.RollNumber || row.roll || row.Roll || "")
        .toString()
        .trim();
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
      return res.status(400).json({ ok: false, message: "CSV validation failed", errors });
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
    console.error("❌ uploadParticipantsCsv:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to upload participants" });
  }
};

// POST /events/:id/publish
exports.publishEvent = async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId });
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });

    if (event.status === "CLOSED" || event.closeAtActual) {
      return res.status(400).json({ ok: false, message: "Event is closed and cannot be published" });
    }

    if (!event.name || !event.name.trim()) {
      return res.status(400).json({ ok: false, message: "Event name is required before publish" });
    }

    if (!event.openAt || !event.closeAtTentative) {
      return res.status(400).json({
        ok: false,
        message: "Feedback window (open/close) is required before publish",
      });
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
    console.error("❌ publishEvent:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to publish event" });
  }
};

// GET /events/:id
exports.getEventById = async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId });
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });

    return res.json({
      ok: true,
      event: { ...event.toObject(), effectiveStatus: computeEffectiveStatus(event) },
    });
  } catch (err) {
    console.error("❌ getEventById:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to fetch event" });
  }
};

// POST /events/:id/close
exports.closeEvent = async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId });
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });

    const effective = computeEffectiveStatus(event);
    if (effective !== "OPEN") {
      return res.status(400).json({ ok: false, message: "Only OPEN events can be closed" });
    }

    event.status = "CLOSED";
    event.closeAtActual = new Date();
    await event.save();

    return res.json({
      ok: true,
      message: "Event closed successfully",
      event: { ...event.toObject(), effectiveStatus: computeEffectiveStatus(event) },
    });
  } catch (err) {
    console.error("❌ closeEvent:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to close event" });
  }
};

const { uploadToSpaces } = require("../utils/uploadImage");
const FeedbackSubmission = require("../models/FeedbackSubmission");

// POST /events/:id/poster
exports.uploadEventPoster = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "No file uploaded" });
    }

    const event = await Event.findOne({
      _id: req.params.id,
      groupId: req.user.groupId,
    });
    if (!event) {
      return res.status(404).json({ ok: false, message: "Event not found" });
    }

    // Upload to DO Spaces
    const posterUrl = await uploadToSpaces(
      req.file.buffer,
      req.file.originalname,
      "event-posters"
    );

    // Update event document
    event.posterUrl = posterUrl;
    await event.save();

    return res.json({
      ok: true,
      message: "Poster uploaded successfully",
      posterUrl,
    });
  } catch (err) {
    console.error("❌ uploadEventPoster:", err.message);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to upload poster" });
  }
};

// POST /events/:id/logo
exports.uploadEventLogo = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "No file uploaded" });
    }

    const event = await Event.findOne({
      _id: req.params.id,
      groupId: req.user.groupId,
    });
    if (!event) {
      return res.status(404).json({ ok: false, message: "Event not found" });
    }

    // Upload to DO Spaces
    const logoUrl = await uploadToSpaces(
      req.file.buffer,
      req.file.originalname,
      "event-logos"
    );

    // Update event document
    event.logoUrl = logoUrl;
    await event.save();

    return res.json({
      ok: true,
      message: "Logo uploaded successfully",
      logoUrl,
    });
  } catch (err) {
    console.error("❌ uploadEventLogo:", err.message);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to upload logo" });
  }
};

// GET /events/feedback-summary
exports.getFeedbackSummary = async (req, res) => {
  try {
    const events = await Event.find({
      groupId: req.user.groupId,
      status: { $in: ["PUBLISHED", "CLOSED"] },
    }).sort({ createdAt: -1 });

    const summaries = await Promise.all(
      events.map(async (event) => {
        const participants = await Participant.find({ eventId: event._id });
        const emailToName = {};
        participants.forEach(p => {
          emailToName[p.email] = p.name || p.email;
        });

        const submissionAgg = await FeedbackSubmission.aggregate([
          { $match: { eventId: event._id, submittedAt: { $ne: null } } },
          {
            $group: {
              _id: "$raterEmail",
              submittedCount: { $sum: 1 },
              ratedTargets: { $push: "$targetEmail" }
            }
          }
        ]);

        const submissionMap = {};
        submissionAgg.forEach(s => {
          submissionMap[s._id] = {
            count: s.submittedCount,
            targets: s.ratedTargets.map(email => ({
              email,
              name: emailToName[email] || email
            }))
          };
        });

        const enrichedParticipants = participants.map(p => {
          const stats = submissionMap[p.email] || { count: 0, targets: [] };
          const requiredCount = participants.length - 1;

          return {
            ...p.toObject(),
            submittedCount: stats.count,
            requiredCount,
            completionPct: requiredCount > 0 ? Math.round((stats.count / requiredCount) * 100) : 0,
            isComplete: stats.count >= requiredCount && requiredCount > 0,
            ratedTargets: stats.targets
          };
        });

        return {
          event: {
            ...event.toObject(),
            effectiveStatus: computeEffectiveStatus(event)
          },
          totalParticipants: participants.length,
          fullySubmittedCount: enrichedParticipants.filter(p => p.isComplete).length,
          notStartedCount: enrichedParticipants.filter(p => p.submittedCount === 0).length,
          participants: enrichedParticipants,
        };
      })
    );

    return res.json({ ok: true, summaries });
  } catch (err) {
    console.error("❌ getFeedbackSummary:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to fetch feedback summary" });
  }
};

// GET /events/suggestions
exports.getSuggestions = async (req, res) => {
  try {
    const groupId = req.user.groupId;

    const levelsResult = await Event.aggregate([
      { $match: { groupId } },
      { $unwind: "$levels" },
      { $group: { _id: "$levels" } },
      { $limit: 30 }
    ]);

    const committeesResult = await Event.aggregate([
      { $match: { groupId } },
      { $unwind: "$committees" },
      { $group: { _id: "$committees.name" } },
      { $limit: 30 }
    ]);

    return res.json({
      ok: true,
      levels: levelsResult.map(r => r._id),
      committees: committeesResult.map(r => r._id)
    });
  } catch (err) {
    console.error("❌ getSuggestions:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to fetch suggestions" });
  }
};
