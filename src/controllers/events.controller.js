const Event = require("../models/Event");
const Participant = require("../models/Participant");
const Authority = require("../models/Authority");
const Student = require("../models/Student");
const University = require("../models/University");
const mongoose = require("mongoose");
const { computeEffectiveStatus } = require("../utils/eventStatus");
const { mapEventForStudentFeed } = require("../utils/eventFeed");
const { parse } = require("csv-parse/sync");

const STUDENT_FEED_DEFAULT_LIMIT = 20;
const STUDENT_FEED_COMPAT_LIMIT = 50;
const STUDENT_FEED_MAX_LIMIT = 50;
const STUDENT_FEED_FILTERS = new Set(["RELEVANT", "UNIVERSITY", "OUTSIDE"]);
const STUDENT_FEED_SEARCH_INDEX = "events_search";
const STUDENT_FEED_SEARCH_PATHS = ["name", "description", "venue", "type", "universityName", "skills"];

// GET /events/feed?uid=FIREBASE_UID
exports.getStudentFeed = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(400).json({ ok: false, message: "uid is required" });

    const student = await Student.findOne({ uid });
    if (!student || !student.universityId) {
      return res.status(400).json({ ok: false, message: "Student university not set" });
    }

    const studentUniversityId = student.universityId.toString();
    const feedOptions = parseStudentFeedOptions(req.query || {});
    if (feedOptions.error) {
      return res.status(400).json({ ok: false, message: feedOptions.error });
    }

    const events = await fetchStudentFeedEvents(feedOptions, studentUniversityId);
    const pageEvents = events.slice(0, feedOptions.limit);
    const mapped = pageEvents.map((e) => mapEventForStudentFeed(e, studentUniversityId));
    const hasMore = events.length > feedOptions.limit;
    const lastItem = pageEvents[pageEvents.length - 1];
    const nextCursor = hasMore && lastItem ? encodeStudentFeedCursor(lastItem) : null;

    return res.json({ ok: true, studentUniversityId, items: mapped, nextCursor, hasMore });
  } catch (err) {
    console.error("❌ getStudentFeed:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to fetch feed" });
  }
};

function parseStudentFeedOptions(query) {
  const hasNewFeedParams = ["limit", "cursor", "q", "filter"].some((param) => query[param] !== undefined);
  const requestedLimit = Number(query.limit);
  const limit = hasNewFeedParams
    ? Math.min(Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : STUDENT_FEED_DEFAULT_LIMIT, STUDENT_FEED_MAX_LIMIT)
    : STUDENT_FEED_COMPAT_LIMIT;
  const filter = String(query.filter || "RELEVANT").toUpperCase();
  if (!STUDENT_FEED_FILTERS.has(filter)) {
    return { error: "Invalid filter" };
  }

  let cursor = null;
  if (query.cursor) {
    cursor = decodeStudentFeedCursor(query.cursor);
    if (!cursor) {
      return { error: "Invalid cursor" };
    }
  }

  return {
    limit,
    cursor,
    q: typeof query.q === "string" ? query.q.trim() : "",
    filter,
  };
}

function decodeStudentFeedCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const createdAt = new Date(parsed.createdAt);
    if (!parsed.id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

function encodeStudentFeedCursor(event) {
  const eventObj = event.toObject ? event.toObject() : event;
  return Buffer.from(
    JSON.stringify({
      createdAt: new Date(eventObj.createdAt).toISOString(),
      id: eventObj._id.toString(),
    }),
  ).toString("base64url");
}

function buildStudentFeedFilter(filter, studentUniversityId) {
  const criteria = { status: "PUBLISHED" };
  const universityId = toMongoObjectId(studentUniversityId);
  if (filter === "UNIVERSITY") {
    criteria.universityId = universityId;
  }
  if (filter === "OUTSIDE") {
    criteria.universityId = { $ne: universityId };
  }
  return criteria;
}

function toMongoObjectId(value) {
  const stringValue = value.toString();
  return mongoose.Types.ObjectId.isValid(stringValue) ? new mongoose.Types.ObjectId(stringValue) : stringValue;
}

function buildCursorCriteria(cursor) {
  if (!cursor) return null;
  return {
    $or: [
      { createdAt: { $lt: cursor.createdAt } },
      {
        createdAt: cursor.createdAt,
        _id: { $lt: cursor.id },
      },
    ],
  };
}

async function fetchStudentFeedEvents(options, studentUniversityId) {
  const cursorCriteria = buildCursorCriteria(options.cursor);
  if (options.q) {
    const pipeline = [
      {
        $search: {
          index: STUDENT_FEED_SEARCH_INDEX,
          compound: {
            must: [
              {
                text: {
                  query: options.q,
                  path: STUDENT_FEED_SEARCH_PATHS,
                  fuzzy: {
                    maxEdits: 2,
                    prefixLength: 1,
                  },
                },
              },
            ],
            filter: [
              {
                equals: { path: "status", value: "PUBLISHED" },
              },
            ],
          },
        },
      },
    ];

    const mobileFilter = buildStudentFeedFilter(options.filter, studentUniversityId);
    delete mobileFilter.status;
    if (Object.keys(mobileFilter).length > 0) {
      pipeline.push({ $match: mobileFilter });
    }
    if (cursorCriteria) {
      pipeline.push({ $match: cursorCriteria });
    }
    pipeline.push({ $sort: { createdAt: -1, _id: -1 } });
    pipeline.push({ $limit: options.limit + 1 });

    return Event.aggregate(pipeline);
  }

  const filter = buildStudentFeedFilter(options.filter, studentUniversityId);
  if (cursorCriteria) {
    Object.assign(filter, cursorCriteria);
  }

  return Event.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(options.limit + 1);
}

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

    // If venue is provided, save it to the university's known venues
    if (event.venue && event.universityId) {
      try {
        await University.updateOne(
          { _id: event.universityId },
          { $addToSet: { venues: event.venue } }
        );
      } catch (err) {
        console.error("❌ Failed to update university venues:", err.message);
      }
    }

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

    if (event.openAt && event.closeAtTentative && new Date(event.openAt) >= new Date(event.closeAtTentative)) {
      return res.status(400).json({ ok: false, message: "Invalid feedback window: open must be before close" });
    }

    const participantsCount = await Participant.countDocuments({ eventId: event._id });

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

const { uploadImage } = require("../utils/uploadImage");
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

    const posterUrl = await uploadImage(
      req.file.buffer,
      req.file.originalname,
      "beyond-grades/event-posters",
      595,
      842
    );

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

    const logoUrl = await uploadImage(
      req.file.buffer,
      req.file.originalname,
      "beyond-grades/event-logos",
      512,
      512
    );

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
    const authority = await Authority.findOne({ email: req.user.email });
    if (!authority) return res.status(403).json({ ok: false, message: "Not an authority" });


    // Aggregate across ALL published/closed events to get global top suggestions
    const levelsResult = await Event.aggregate([
      { $match: { status: { $in: ["PUBLISHED", "CLOSED"] } } },
      { $unwind: "$levels" },
      { $group: { _id: { $trim: { input: { $toLower: "$levels" } } }, originalName: { $first: "$levels" }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 30 }
    ]);

    const committeesResult = await Event.aggregate([
      { $match: { status: { $in: ["PUBLISHED", "CLOSED"] } } },
      { $unwind: "$committees" },
      { $group: { _id: { $trim: { input: { $toLower: "$committees.name" } } }, originalName: { $first: "$committees.name" }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 30 }
    ]);

    const universityData = await University.findOne({
      _id: authority.universityId
    }).select("venues");

    return res.json({
      ok: true,
      levels: levelsResult.map(r => r.originalName).filter(Boolean),
      committees: committeesResult.map(r => r.originalName).filter(Boolean),
      venues: (universityData?.venues || []).slice(0, 30)
    });
  } catch (err) {
    console.error("❌ getSuggestions:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to fetch suggestions" });
  }
};
