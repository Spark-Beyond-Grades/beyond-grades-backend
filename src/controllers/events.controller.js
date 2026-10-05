const Event = require("../models/Event");
const Participant = require("../models/Participant");
const Authority = require("../models/Authority");
const Student = require("../models/Student");
const University = require("../models/University");
const mongoose = require("mongoose");
const { computeEffectiveStatus, joinablePublishedFilter } = require("../utils/eventStatus");
const { mapEventForStudentFeed } = require("../utils/eventFeed");
const { parse } = require("csv-parse/sync");
const FeedbackSubmission = require("../models/FeedbackSubmission");
const { scoreEvent, auditStatus, uniqueParticipants, alignScoringConfigToStructure } = require("../utils/epaFormula");
const { cell, canonicalChoice, cleanEmail, uniqueSkills, canonicalEventStructure, unmatchedAllowedLevel } = require("../utils/csvMatch");
const { emailMatchQuery } = require("../utils/emailQuery");
const { calendarDate } = require("../utils/calendarDate");

function reviewIsComplete(submission, skills) {
  const ratings = submission?.ratings || [];
  return skills.length > 0 && skills.every((skill) => ratings.some((rating) => {
    if (canonicalChoice(rating?.skill, [skill]) !== skill || rating.skipped === true) return false;
    if (typeof rating.score === "string" && rating.score.trim() === "") return false;
    if (rating.score === null || rating.score === undefined || rating.score === false || rating.score === true) return false;
    return Number.isFinite(Number(typeof rating.score === "string" ? rating.score.trim() : rating.score));
  }));
}

async function archivePreviousSnapshot(event) {
  if (!event.frozenScores) return;
  if (Array.isArray(event.frozenScoreHistory)) {
    event.frozenScoreHistory = [...event.frozenScoreHistory, event.frozenScores];
    event.markModified?.("frozenScoreHistory");
    return;
  }
  await Event.updateOne({ _id: event._id }, { $push: { frozenScoreHistory: event.frozenScores } });
}

async function scoreHistoryTimes(eventId) {
  const [row] = await Event.aggregate([
    { $match: { _id: eventId } },
    { $project: { _id: 0, frozenAt: "$frozenScoreHistory.frozenAt" } },
  ]);
  return (row?.frozenAt || []).map((frozenAt) => ({ frozenAt: frozenAt || null }));
}

function presentAuthorityEvent(event, extra = {}) {
  const eventObj = event.toObject ? event.toObject() : { ...event };
  if (!eventObj.eventDate && eventObj.eventStartDate) eventObj.eventDate = eventObj.eventStartDate;
  const structure = canonicalEventStructure(eventObj);
  const scoringConfig = eventObj.scoringConfig
    ? alignScoringConfigToStructure(eventObj.scoringConfig, structure)
    : eventObj.scoringConfig;
  return {
    ...eventObj,
    ...structure,
    ...(scoringConfig ? { scoringConfig } : {}),
    ...extra,
    effectiveStatus: computeEffectiveStatus(event),
  };
}

function withAudit(scored, event) {
  const closed = event?.status === "CLOSED" || Boolean(event?.closeAtActual);
  return { ...scored, auditStatus: auditStatus(scored, { closed }) };
}

async function withParticipantNames(scored, participants) {
  const roster = uniqueParticipants(participants);
  const names = new Map(roster.map((person) => [person.email, String(person.name || "").trim()]));
  const missing = roster.filter((person) => person.email && !names.get(person.email)).map((person) => person.email);
  if (missing.length) {
    try {
      const accounts = await Student.find(emailMatchQuery("email", missing)).select("email name").lean();
      for (const account of accounts) {
        const email = cleanEmail(account.email);
        const accountName = String(account.name || "").trim();
        if (email && accountName && !names.get(email)) names.set(email, accountName);
      }
    } catch (err) {
      console.error("withParticipantNames error:", err);
    }
  }
  return {
    ...scored,
    participants: (scored.participants || []).map((person) => {
      const name = names.get(cleanEmail(person.email)) || "";
      return name ? { ...person, name } : person;
    }),
  };
}

const SCORING_ENUMS = {
  evenMedianRule: ["average", "lower", "higher"],
  blankSkillPolicy: ["ignoreSkill", "ignorePair"],
  unscoredSkillPolicy: ["exclude", "block"],
  crossEventRule: ["none", "equal", "confidence"],
  lateSubmissions: ["allow", "reject"],
};

const SCORING_VALUE_LABELS = {
  scaleMin: "lowest raw rating",
  scaleMax: "highest raw rating",
  levelInfluence: "level influence",
  committeeWeightSame: "same-committee weight",
  committeeWeightTop: "top-rank weight",
  committeeWeightOther: "other-committee weight",
  credibilityEpsilon: "credibility constant",
  credibilityShrinkage: "credibility shrinkage",
  confidencePrior: "confidence prior",
  minimumRatings: "minimum review count",
  evenMedianRule: "even-median rule",
  blankSkillPolicy: "blank-skill rule",
  unscoredSkillPolicy: "unscored-skill rule",
  crossEventRule: "cross-event rule",
  lateSubmissions: "late-review rule",
  allowSelfRatings: "self-rating choice",
  applyRelevanceToSkillWeights: "relevance choice",
  contributesToScoring: "whether this event counts toward EPA",
  showComments: "comment visibility",
  identifyRaters: "who-reviewed-whom choice",
};

function scoringValueLabel(key) {
  if (key.startsWith("positive:")) {
    const field = key.slice("positive:".length);
    return `a ${SCORING_VALUE_LABELS[field] || field} above zero`;
  }
  if (key.startsWith("nonNegative:skillWeight:")) {
    return `a skill weight for ${key.slice("nonNegative:skillWeight:".length)} of zero or higher`;
  }
  if (key.startsWith("nonNegative:relevance:")) {
    const [, , committee, skill] = key.split(":");
    return `relevance for ${committee} and ${skill} of zero or higher`;
  }
  if (key.startsWith("nonNegative:")) {
    const field = key.slice("nonNegative:".length);
    return `a ${SCORING_VALUE_LABELS[field] || field} of zero or higher`;
  }
  if (key.startsWith("levelRank:")) return `the rank for ${key.slice("levelRank:".length)}`;
  if (key.startsWith("skillWeight:")) return `the skill weight for ${key.slice("skillWeight:".length)}`;
  if (key.startsWith("relevance:")) {
    const [, committee, skill] = key.split(":");
    return `the relevance for ${committee} and ${skill}`;
  }
  return SCORING_VALUE_LABELS[key] || key;
}

function scoringSaveMessage(invalid) {
  const problems = invalid.map(scoringValueLabel);
  const constraints = invalid.every((key) => key.startsWith("nonNegative:") || key.startsWith("positive:"));
  if (constraints) return `Enter ${problems.join(", ")}`;
  return `Enter a valid value for ${problems.join(", ")}`;
}

function scoringBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes" || normalized === "true") return true;
  if (normalized === "no" || normalized === "false") return false;
  return undefined;
}

function scoringNumber(value) {
  if (value === "" || value === undefined) return { skip: true };
  if (value === null) return { value: null };
  if (typeof value === "boolean" || (typeof value === "string" && value.trim() === "")) return { invalid: true };
  const number = Number(typeof value === "string" ? value.trim() : value);
  if (!Number.isFinite(number)) return { invalid: true };
  return { value: number };
}

function numericMap(input, invalid, prefix) {
  const output = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === "" || value === null || value === undefined) continue;
    const parsed = scoringNumber(value);
    if (parsed.invalid || parsed.value == null) invalid.push(`${prefix}:${key}`);
    else output[key] = parsed.value;
  }
  return output;
}

function sanitizeScoringConfig(input) {
  const config = {};
  const invalid = [];
  for (const field of ["scaleMin", "scaleMax", "levelInfluence", "committeeWeightSame", "committeeWeightTop", "committeeWeightOther", "credibilityEpsilon", "credibilityShrinkage", "confidencePrior"]) {
    const parsed = scoringNumber(input[field]);
    if (parsed.skip) continue;
    if (parsed.invalid) invalid.push(field);
    else config[field] = parsed.value;
  }
  for (const [field, allowed] of Object.entries(SCORING_ENUMS)) {
    if (typeof input[field] !== "string" || !input[field]) continue;
    if (!allowed.includes(input[field])) invalid.push(field);
    else config[field] = input[field];
  }
  for (const field of ["allowSelfRatings", "applyRelevanceToSkillWeights", "contributesToScoring", "showComments", "identifyRaters"]) {
    if (input[field] === undefined || input[field] === null || input[field] === "") continue;
    const choice = scoringBoolean(input[field]);
    if (choice === undefined) invalid.push(field);
    else config[field] = choice;
  }
  if (input.minimumRatings !== undefined) {
    const parsed = scoringNumber(input.minimumRatings);
    if (!parsed.skip && parsed.value !== null) {
      if (parsed.invalid) invalid.push("minimumRatings");
      else config.minimumRatings = parsed.value;
    }
  }
  if (input.levelRanks && typeof input.levelRanks === "object") config.levelRanks = numericMap(input.levelRanks, invalid, "levelRank");
  if (input.skillWeights && typeof input.skillWeights === "object") config.skillWeights = numericMap(input.skillWeights, invalid, "skillWeight");
  if (input.relevance && typeof input.relevance === "object") {
    config.relevance = {};
    for (const [committee, skills] of Object.entries(input.relevance)) {
      if (skills && typeof skills === "object") config.relevance[committee] = numericMap(skills, invalid, `relevance:${committee}`);
    }
  }
  if (config.credibilityEpsilon != null && config.credibilityEpsilon <= 0) invalid.push("positive:credibilityEpsilon");
  for (const field of ["committeeWeightSame", "committeeWeightTop", "committeeWeightOther", "credibilityShrinkage", "confidencePrior"]) {
    if (config[field] != null && config[field] < 0) invalid.push(`nonNegative:${field}`);
  }
  if (config.minimumRatings != null && config.minimumRatings < 0) invalid.push("nonNegative:minimumRatings");
  for (const [skill, weight] of Object.entries(config.skillWeights || {})) {
    if (weight < 0) invalid.push(`nonNegative:skillWeight:${skill}`);
  }
  for (const [committee, skills] of Object.entries(config.relevance || {})) {
    for (const [skill, value] of Object.entries(skills)) {
      if (value < 0) invalid.push(`nonNegative:relevance:${committee}:${skill}`);
    }
  }
  return { config, invalid };
}

const STUDENT_FEED_HIDDEN = {
  frozenScoreHistory: 0,
  frozenScores: 0,
  scoringConfig: 0,
  createdByEmail: 0,
  groupId: 0,
};
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

function buildStudentFeedFilter(filter, studentUniversityId, now = new Date()) {
  const criteria = joinablePublishedFilter(now);
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
        _id: { $lt: toMongoObjectId(cursor.id) },
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
    pipeline.push({ $project: STUDENT_FEED_HIDDEN });

    try {
      return await Event.aggregate(pipeline);
    } catch (err) {
      console.error("event search index failed, using text match:", err.message);
      return fetchStudentFeedByText(options, studentUniversityId, cursorCriteria);
    }
  }

  const filter = buildStudentFeedFilter(options.filter, studentUniversityId);
  if (cursorCriteria) {
    Object.assign(filter, cursorCriteria);
  }

  return Event.find(filter, STUDENT_FEED_HIDDEN)
    .sort({ createdAt: -1, _id: -1 })
    .limit(options.limit + 1);
}

function escapeSearchText(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fetchStudentFeedByText(options, studentUniversityId, cursorCriteria) {
  const filter = buildStudentFeedFilter(options.filter, studentUniversityId);
  const pattern = new RegExp(escapeSearchText(options.q), "i");
  filter.$or = STUDENT_FEED_SEARCH_PATHS.map((path) => ({ [path]: pattern }));
  const query = cursorCriteria ? { $and: [filter, cursorCriteria] } : filter;
  return Event.find(query, STUDENT_FEED_HIDDEN)
    .sort({ createdAt: -1, _id: -1 })
    .limit(options.limit + 1);
}

// POST /events
exports.createDraftEvent = async (req, res) => {
  try {
    const { name = "", type = "OTHER", description = "", templateId = "T1", minAppBuild = 1 } = req.body || {};

    const authority = await Authority.findOne(emailMatchQuery("email", req.user.email));
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
      event: presentAuthorityEvent(event),
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
    }, { frozenScoreHistory: 0 }).sort({ createdAt: -1 });

    const mapped = events.map((e) => presentAuthorityEvent(e));

    return res.json({ ok: true, events: mapped });
  } catch (err) {
    console.error("❌ listEvents:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to fetch events" });
  }
};

// PUT /events/:id
exports.updateEvent = async (req, res) => {
  try {
    const { name, type, description, eventStartDate, eventEndDate, venue, openAt, closeAtTentative, levels, committees, skills, posterUrl, logoUrl, scoringConfig } =
      req.body || {};

    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId }, { frozenScoreHistory: 0 });
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });

    if (event.status === "CLOSED" || event.closeAtActual) {
      return res.status(400).json({ ok: false, message: "Event is closed and cannot be edited" });
    }

    const draft = event.status === "DRAFT";
    if (draft && typeof name === "string") event.name = name.trim();
    if (draft && typeof description === "string") event.description = description.trim();
    if (draft && typeof venue === "string") event.venue = venue.trim();
    if (draft && eventStartDate !== undefined) {
      const parsed = calendarDate(eventStartDate);
      if (parsed?.invalid) return res.status(400).json({ ok: false, message: "Enter a valid date and time" });
      event.eventStartDate = parsed;
      event.eventDate = event.eventStartDate; // Mirror to old field for database views
    }
    if (draft && eventEndDate !== undefined) {
      const parsed = calendarDate(eventEndDate);
      if (parsed?.invalid) return res.status(400).json({ ok: false, message: "Enter a valid date and time" });
      event.eventEndDate = parsed;
    }

    if (draft && typeof type === "string") {
      const allowed = ["CLUB", "PROJECT", "FEST", "COMMITTEE", "OTHER"];
      if (!allowed.includes(type)) {
        return res.status(400).json({ ok: false, message: "Invalid event type" });
      }
      event.type = type;
    }

    if (posterUrl !== undefined) event.posterUrl = posterUrl;
    if (logoUrl !== undefined) event.logoUrl = logoUrl;

    if (openAt !== undefined) {
      const parsed = calendarDate(openAt);
      if (parsed?.invalid) return res.status(400).json({ ok: false, message: "Enter a valid date and time" });
      event.openAt = parsed;
    }
    if (closeAtTentative !== undefined) {
      const parsed = calendarDate(closeAtTentative);
      if (parsed?.invalid) return res.status(400).json({ ok: false, message: "Enter a valid date and time" });
      event.closeAtTentative = parsed;
    }

    if (event.openAt && event.closeAtTentative && event.openAt >= event.closeAtTentative) {
      return res.status(400).json({
        ok: false,
        message: "Invalid dates: openAt must be before closeAtTentative",
      });
    }

    if (draft && Array.isArray(levels)) {
      event.levels = canonicalEventStructure({ levels }).levels;
    }

    if (draft && Array.isArray(committees)) {
      const unmatched = unmatchedAllowedLevel(committees, event.levels || []);
      if (unmatched) {
        return res.status(400).json({
          ok: false,
          message: `Invalid mapping: level "${unmatched}" not present in levels[]`,
        });
      }
      event.committees = canonicalEventStructure({ levels: event.levels, committees }).committees;
    }

    if (draft && Array.isArray(skills)) {
      event.skills = uniqueSkills(skills);
    }

    if (scoringConfig && typeof scoringConfig === "object") {
      const sanitized = sanitizeScoringConfig(scoringConfig);
      if (sanitized.invalid.length) {
        return res.status(400).json({
          ok: false,
          message: scoringSaveMessage(sanitized.invalid),
        });
      }
      event.scoringConfig = sanitized.config;
      event.markModified("scoringConfig");
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
      event: presentAuthorityEvent(event),
    });
  } catch (err) {
    console.error("❌ updateEvent:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to update event" });
  }
};

// GET /events/:id/participants
exports.getParticipants = async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId }, { frozenScoreHistory: 0 });
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });

    const participants = await Participant.find({ eventId: event._id }).sort({ createdAt: -1 });
    return res.json({ ok: true, participants });
  } catch (err) {
    console.error("❌ getParticipants:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to fetch participants" });
  }
};

// DELETE /events/:id/participants
exports.removeParticipant = async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email || "");
    if (!email) return res.status(400).json({ ok: false, message: "Email is required" });

    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId }, { frozenScoreHistory: 0 });
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });
    if (event.status === "CLOSED" || event.closeAtActual) {
      return res.status(400).json({ ok: false, message: "Event is closed and its participant list is locked" });
    }

    const removed = await Participant.deleteMany({
      eventId: event._id,
      ...emailMatchQuery("email", email),
    });
    if (!removed.deletedCount) return res.status(404).json({ ok: false, message: "Participant not found" });
    await FeedbackSubmission.deleteMany({
      eventId: event._id,
      $or: [
        emailMatchQuery("raterEmail", email),
        emailMatchQuery("targetEmail", email),
      ],
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ removeParticipant:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to remove participant" });
  }
};

// POST /events/:id/participants/upload
exports.uploadParticipantsCsv = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "CSV file is required" });

    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId }, { frozenScoreHistory: 0 });
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });
    if (event.status === "CLOSED" || event.closeAtActual) {
      return res.status(400).json({ ok: false, message: "Event is closed and its participant list is locked" });
    }

    const csvText = req.file.buffer.toString("utf-8");

    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ ok: false, message: "CSV has no rows" });
    }

    const structure = canonicalEventStructure(event);
    const committeeOptions = (structure.committees || []).map((committee) => committee.name).filter(Boolean);
    const levelOptions = structure.levels || [];

    const errors = [];
    const seenEmails = new Set();
    const docs = [];

    for (let i = 0; i < records.length; i++) {
      const row = records[i] || {};

      const name = cell(row, ["name"]).trim();
      const email = cleanEmail(cell(row, ["email"]));
      const rollNumber = cell(row, ["rollnumber", "roll", "roll number"]).trim();
      const committeeInput = cell(row, ["committee", "committee name"]).trim();
      const levelInput = cell(row, ["level"]).trim();
      const position = cell(row, ["position"]).trim();
      const committee = committeeOptions.length ? canonicalChoice(committeeInput, committeeOptions) : committeeInput;
      const level = levelOptions.length ? canonicalChoice(levelInput, levelOptions) : levelInput;

      if (!email) {
        errors.push({ row: i + 2, field: "email", message: "Missing email" });
        continue;
      }

      if (seenEmails.has(email)) {
        errors.push({ row: i + 2, field: "email", message: "Duplicate email in CSV" });
        continue;
      }
      seenEmails.add(email);

      if (committeeOptions.length > 0 && !committee) {
        errors.push({
          row: i + 2,
          field: "committee",
          message: committeeInput ? `Unknown committee "${committeeInput}"` : "Committee is required",
        });
        continue;
      }

      if (levelOptions.length > 0 && !level) {
        errors.push({
          row: i + 2,
          field: "level",
          message: levelInput ? `Unknown level "${levelInput}"` : "Level is required",
        });
        continue;
      }

      const committeeRow = (structure.committees || []).find((item) => item.name === committee);
      if (committeeRow?.allowedLevels?.length && level && !committeeRow.allowedLevels.some((allowed) => canonicalChoice(level, [allowed]))) {
        errors.push({ row: i + 2, field: "level", message: `Level "${levelInput}" is not mapped to ${committee}` });
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

    const existingRows = await Participant.find({ eventId: event._id }).select("_id email").lean();
    const existingByEmail = new Map();
    for (const row of existingRows) {
      const key = cleanEmail(row.email);
      if (key && !existingByEmail.has(key)) existingByEmail.set(key, row);
    }

    const ops = docs.map((d) => {
      const set = { email: d.email };
      for (const field of ["name", "rollNumber", "committee", "level", "position"]) {
        if (d[field]) set[field] = d[field];
      }
      const existing = existingByEmail.get(d.email);
      if (existing) {
        return { updateOne: { filter: { _id: existing._id }, update: { $set: set } } };
      }
      return {
        updateOne: {
          filter: { eventId: d.eventId, email: d.email },
          update: { $set: set, $setOnInsert: { eventId: d.eventId } },
          upsert: true,
        },
      };
    });

    const result = await Participant.bulkWrite(ops, { ordered: false });

    return res.json({
      ok: true,
      inserted: result.upsertedCount || 0,
      updated: result.modifiedCount || 0,
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
    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId }, { frozenScoreHistory: 0 });
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
      event: presentAuthorityEvent(event, { participantsCount }),
    });
  } catch (err) {
    console.error("❌ publishEvent:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to publish event" });
  }
};

// GET /events/:id
exports.getEventById = async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId }, { frozenScoreHistory: 0 });
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });

    return res.json({
      ok: true,
      event: {
        ...presentAuthorityEvent(event),
        frozenScoreHistory: await scoreHistoryTimes(event._id),
      },
    });
  } catch (err) {
    console.error("❌ getEventById:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to fetch event" });
  }
};

exports.deleteEvent = async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId }, { frozenScoreHistory: 0 });
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });
    await Participant.deleteMany({ eventId: event._id });
    await FeedbackSubmission.deleteMany({ eventId: event._id });
    await Event.deleteOne({ _id: event._id });
    return res.json({ ok: true });
  } catch (err) {
    console.error("deleteEvent error:", err);
    return res.status(500).json({ ok: false, message: "Failed to delete event" });
  }
};

exports.previewEventScores = async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId }, { frozenScoreHistory: 0 }).lean();
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });
    const participants = await Participant.find({ eventId: event._id }).lean();
    if ((event.status === "CLOSED" || event.closeAtActual) && event.frozenScores) {
      return res.json({ ok: true, scored: await withParticipantNames(withAudit(event.frozenScores, event), participants) });
    }
    const submissions = await FeedbackSubmission.find({ eventId: event._id, submittedAt: { $ne: null } }).lean();
    return res.json({
      ok: true,
      scored: await withParticipantNames(withAudit(scoreEvent({
        skills: event.skills || [],
        participants,
        submissions,
        config: event.scoringConfig,
      }), event), participants),
    });
  } catch (err) {
    console.error("previewEventScores error:", err);
    return res.status(500).json({ ok: false, message: "Failed to preview scores" });
  }
};

exports.recalculateEventScores = async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId }, { frozenScoreHistory: 0 });
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });
    return res.status(410).json({ ok: false, message: "EPA is finalized only by Calculate EPA & End Feedback" });
  } catch (err) {
    console.error("recalculateEventScores error:", err);
    return res.status(500).json({ ok: false, message: "Failed to recalculate scores" });
  }
};

// POST /events/:id/close
exports.closeEvent = async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, groupId: req.user.groupId }, { frozenScoreHistory: 0 });
    if (!event) return res.status(404).json({ ok: false, message: "Event not found" });

    if (event.status !== "PUBLISHED" || event.closeAtActual) {
      return res.status(400).json({ ok: false, message: "Only a published event that has not been closed can be closed" });
    }

    event.status = "CLOSED";
    event.closeAtActual = new Date();
    const archivedWithoutLoading = Boolean(event.frozenScores) && !Array.isArray(event.frozenScoreHistory);
    await archivePreviousSnapshot(event);
    const participants = await Participant.find({ eventId: event._id }).lean();
    const submissions = await FeedbackSubmission.find({ eventId: event._id, submittedAt: { $ne: null } }).lean();
    event.frozenScores = await withParticipantNames({
      ...withAudit(scoreEvent({
        skills: event.skills || [],
        participants,
        submissions,
        config: event.scoringConfig,
      }), event),
      frozenAt: new Date(),
    }, participants);
    event.markModified("frozenScores");
    await event.save();

    const closedEvent = presentAuthorityEvent(event);
    if (archivedWithoutLoading) {
      closedEvent.frozenScoreHistory = await scoreHistoryTimes(event._id);
    }
    return res.json({
      ok: true,
      message: "Event closed successfully",
      event: closedEvent,
    });
  } catch (err) {
    console.error("❌ closeEvent:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to close event" });
  }
};

const { uploadImage } = require("../utils/uploadImage");

// POST /events/:id/poster
exports.uploadEventPoster = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "No file uploaded" });
    }

    const event = await Event.findOne({
      _id: req.params.id,
      groupId: req.user.groupId,
    }, { frozenScoreHistory: 0 });
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
    }, { frozenScoreHistory: 0 });
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
    }, { frozenScoreHistory: 0 }).sort({ createdAt: -1 });

    const summaries = await Promise.all(
      events.map(async (event) => {
        const participants = uniqueParticipants(await Participant.find({ eventId: event._id }).lean());
        const skills = uniqueSkills(event.skills);
        const allowSelf = event.scoringConfig?.allowSelfRatings === true;
        const identifyRaters = event.scoringConfig?.identifyRaters === true;
        const address = (value) => cleanEmail(value);
        const unnamed = participants
          .filter((person) => !String(person.name || "").trim())
          .map((person) => person.email);
        const accountNames = new Map();
        if (unnamed.length) {
          const accounts = await Student.find(emailMatchQuery("email", unnamed)).select("email name").lean();
          for (const account of accounts) {
            const accountName = String(account.name || "").trim();
            if (accountName) accountNames.set(address(account.email), accountName);
          }
        }
        const displayName = (email, rosterName) => String(rosterName || "").trim() || accountNames.get(address(email)) || "";
        const emailToName = {};
        participants.forEach((person) => {
          emailToName[address(person.email)] = displayName(person.email, person.name) || "Participant";
        });

        const submissions = await FeedbackSubmission.find({
          eventId: event._id,
          submittedAt: { $ne: null },
        }).select("raterEmail targetEmail ratings").lean();
        const submissionMap = {};
        const startedRaters = new Set();
        submissions.forEach((submission) => {
          const rater = address(submission.raterEmail);
          const target = address(submission.targetEmail);
          if (!allowSelf && rater && rater === target) return;
          const mentionsSkill = (submission.ratings || []).some((rating) => canonicalChoice(rating?.skill, skills));
          if (mentionsSkill) startedRaters.add(rater);
          if (!reviewIsComplete(submission, skills)) return;
          const stats = submissionMap[rater] || { count: 0, targets: [] };
          stats.count += 1;
          stats.targets.push({ email: target, name: emailToName[target] || "Participant" });
          submissionMap[rater] = stats;
        });

        const enrichedParticipants = participants.map((person) => {
          const personEmail = address(person.email);
          const stats = submissionMap[personEmail] || { count: 0, targets: [] };
          const requiredCount = skills.length ? Math.max(participants.length - (allowSelf ? 0 : 1), 0) : 0;
          const started = startedRaters.has(personEmail);

          return {
            name: displayName(person.email, person.name),
            email: person.email,
            rollNumber: person.rollNumber || "",
            level: person.level || "",
            committee: person.committee || "",
            submittedCount: stats.count,
            requiredCount,
            completionPct: requiredCount > 0 ? Math.round((stats.count / requiredCount) * 100) : 100,
            isComplete: requiredCount === 0 || stats.count >= requiredCount,
            started,
            ratedTargets: identifyRaters ? stats.targets : [],
          };
        });

        const eventView = { ...(event.toObject ? event.toObject() : { ...event }), ...canonicalEventStructure(event) };
        delete eventView.scoringConfig;
        delete eventView.frozenScores;
        delete eventView.frozenScoreHistory;
        if (!eventView.eventDate && eventView.eventStartDate) eventView.eventDate = eventView.eventStartDate;
        return {
          event: {
            ...eventView,
            effectiveStatus: computeEffectiveStatus(event),
            allowSelfRatings: event.scoringConfig?.allowSelfRatings === true,
            identifyRaters,
          },
          totalParticipants: participants.length,
          fullySubmittedCount: enrichedParticipants.filter(p => p.isComplete).length,
          partialCount: enrichedParticipants.filter((p) => p.requiredCount > 0 && p.started && !p.isComplete).length,
          notStartedCount: enrichedParticipants.filter((p) => p.requiredCount > 0 && !p.started).length,
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
    const authority = await Authority.findOne(emailMatchQuery("email", req.user.email));
    if (!authority?.universityId) return res.status(403).json({ ok: false, message: "Not an authority" });

    const campus = { status: { $in: ["PUBLISHED", "CLOSED"] }, universityId: authority.universityId };
    const levelsResult = await Event.aggregate([
      { $match: campus },
      { $unwind: "$levels" },
      { $group: { _id: { $trim: { input: { $toLower: "$levels" } } }, originalName: { $first: "$levels" }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 30 }
    ]);

    const committeesResult = await Event.aggregate([
      { $match: campus },
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
