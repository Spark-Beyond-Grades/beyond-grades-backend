const Student = require("../models/Student");
const Participant = require("../models/Participant");
const University = require("../models/University");
const FeedbackSubmission = require("../models/FeedbackSubmission");
const Event = require("../models/Event");
const { computeEffectiveStatus } = require("../utils/eventStatus");
const { studentVisibleEvent } = require("../utils/eventFeed");
const { uploadImage, deleteCloudinaryUrl } = require("../utils/uploadImage");
const { scoreEvent, combineOverall, auditStatus, uniqueParticipants, snapToScale, FORMULA_VERSION } = require("../utils/epaFormula");
const { createShareToken, hashShareToken } = require("../utils/shareToken");
const { canonicalChoice, normalizeLabel, cleanEmail, uniqueSkills, canonicalEventStructure } = require("../utils/csvMatch");
const { emailMatchQuery } = require("../utils/emailQuery");
const { allowPublicProfileLookup, publicProfileClientKey } = require("../utils/publicProfileLimit");
const { calendarDate } = require("../utils/calendarDate");

const STUDENT_EVENT_READ = {
  frozenScoreHistory: 0,
  frozenScores: 0,
  createdByEmail: 0,
  groupId: 0,
};

const DASHBOARD_PRIVACY_DEFAULTS = {
  showName: true,
  showPhoto: true,
  shareOverallScore: false,
  shareSkillScores: false,
  shareEventHistory: false,
  shareContributions: false,
};

exports.rotateDashboardShareToken = async (req, res) => {
  try {
    const { token, hash } = createShareToken();
    const student = await Student.findOneAndUpdate(
      { uid: req.user?.uid },
      { $set: { shareTokenHash: hash, shareTokenCreatedAt: new Date(), shareTokenRevokedAt: null } },
      { new: true }
    ).lean();
    if (!student) return res.status(404).json({ ok: false, message: "Student not found" });
    const publicProfileBaseUrl = (process.env.PUBLIC_PROFILE_BASE_URL || "https://beyondgrades.app/profile").replace(/\/$/, "");
    return res.json({ ok: true, token, shareUrl: `${publicProfileBaseUrl}/${token}`, hasShareLink: true, createdAt: student.shareTokenCreatedAt });
  } catch (err) {
    console.error("rotateDashboardShareToken error:", err);
    return res.status(500).json({ ok: false, message: "Failed to create share link" });
  }
};

exports.revokeDashboardShareToken = async (req, res) => {
  try {
    const student = await Student.findOneAndUpdate(
      { uid: req.user?.uid },
      { $set: { shareTokenRevokedAt: new Date() } },
      { new: true }
    ).lean();
    if (!student) return res.status(404).json({ ok: false, message: "Student not found" });
    return res.json({ ok: true, hasShareLink: false });
  } catch (err) {
    console.error("revokeDashboardShareToken error:", err);
    return res.status(500).json({ ok: false, message: "Failed to revoke share link" });
  }
};

exports.getPublicDashboardProfile = async (req, res) => {
  try {
    if (!allowPublicProfileLookup(publicProfileClientKey(req))) {
      return res.status(429).json({ ok: false, message: "Too many profile lookups. Try again shortly." });
    }
    const tokenHash = hashShareToken(req.params.token || "");
    const student = await Student.findOne({
      shareTokenHash: tokenHash,
      shareTokenRevokedAt: null,
    }).lean();
    if (!student) return res.status(404).json({ ok: false, message: "Profile not found" });
    const email = storedAddress(student.email);
    const privacy = { ...DASHBOARD_PRIVACY_DEFAULTS, ...(student.dashboardPrivacy || {}) };
    const scoringEvents = [];
    const scoredEvents = [];
    const skillSourceEvents = [];
    let rosterName = "";
    if (privacy.shareOverallScore || privacy.shareSkillScores || privacy.shareEventHistory || privacy.shareContributions) {
      const events = await eventsJoinedBy(email);
      for (const event of events) {
        const eventId = event._id.toString();
        const participants = uniqueParticipants(await Participant.find({ eventId }).select("email name level committee").lean());
        const selfRow = participants.find((p) => storedAddress(p.email) === email);
        if (!selfRow) continue;
        const selfName = String(selfRow.name || "").trim();
        if (selfName && !rosterName) rosterName = selfName;
        const submissions = await FeedbackSubmission.find({ eventId: event._id, submittedAt: { $ne: null } }).lean();
        const scored = eventScoreSnapshot(event, participants, submissions);
        const mine = (scored.participants || []).find((person) => storedAddress(person.email) === email);
        const row = {
          eventId,
          eventName: event.name || "Untitled event",
          eventDate: event.eventStartDate || event.eventDate || null,
          frozenAt: scored.frozenAt || null,
          eventScore: mine?.eventScore ?? null,
          confidence: mine?.confidence ?? null,
          status: mine?.status || (scored.configured === false ? "NOT_CONFIGURED" : "NO_DATA"),
          auditStatus: auditStatus(scored, { closed: event.status === "CLOSED" || Boolean(event.closeAtActual) }),
          scaleMin: mine?.scaleMin ?? scored.scaleMin ?? null,
          scaleMax: mine?.scaleMax ?? scored.scaleMax ?? null,
          crossEventRule: crossEventRuleFor(event, scored),
          skills: mine?.skills || [],
        };
        scoringEvents.push(row);
        if (mine && (mine.status === "READY" || mine.status === "PROVISIONAL") && mine.eventScore != null) scoredEvents.push(row);
        if ((mine?.skills || []).some((skill) => skill.score != null)) skillSourceEvents.push(row);
      }
    }
    const publicOverall = combineOverall(scoringEvents);
    if (publicOverall) publicOverall.auditStatus = overallAuditStatus(scoringEvents);
    const shownForDate = [];
    const shownIds = new Set();
    const datedEvents = [];
    if (privacy.shareEventHistory || privacy.shareOverallScore || privacy.shareSkillScores) datedEvents.push(...scoredEvents);
    if (privacy.shareSkillScores) datedEvents.push(...skillSourceEvents);
    for (const event of datedEvents) {
      if (shownIds.has(event.eventId)) continue;
      shownIds.add(event.eventId);
      shownForDate.push(event);
    }
    let contributions = null;
    if (privacy.shareContributions) {
      const given = await FeedbackSubmission.find({
        submittedAt: { $ne: null },
        ...emailMatchQuery("raterEmail", email),
      }).select("eventId targetEmail ratings").lean();
      const eventIds = [...new Set(given.map((submission) => String(submission.eventId)))];
      const contributedEvents = eventIds.length
        ? await Event.find({ _id: { $in: eventIds } }).select("name skills scoringConfig").lean()
        : [];
      const skillsByEvent = new Map(contributedEvents.map((event) => [String(event._id), listedSkills(event.skills)]));
      const allowSelfByEvent = new Map(contributedEvents.map((event) => [String(event._id), event.scoringConfig?.allowSelfRatings === true]));
      const names = new Map(contributedEvents.map((event) => [String(event._id), event.name || "Untitled event"]));
      const counts = new Map();
      for (const submission of given) {
        const eventId = String(submission.eventId);
        const skills = skillsByEvent.get(eventId) || [];
        const finished = skills.length > 0 && skills.every((skill) => (submission.ratings || []).some((rating) => answeredSkill(rating, skill)));
        if (!finished) continue;
        const rater = storedAddress(submission.raterEmail) || email;
        if (allowSelfByEvent.get(eventId) !== true && rater === storedAddress(submission.targetEmail)) continue;
        counts.set(eventId, (counts.get(eventId) || 0) + 1);
      }
      contributions = [...counts.entries()].map(([eventId, reviewCount]) => ({
        eventName: names.get(eventId) || "Untitled event",
        reviewCount,
      }));
    }
    return res.json({
      ok: true,
      formulaVersion: FORMULA_VERSION,
      profile: {
        formulaVersion: FORMULA_VERSION,
        calculatedAt: profileCalculatedAt(shownForDate),
        name: privacy.showName ? (String(student.name || "").trim() || rosterName || null) : null,
        photoUrl: privacy.showPhoto ? student.photoUrl || null : null,
        overall: privacy.shareOverallScore ? publicOverall : null,
        skills: privacy.shareSkillScores
          ? skillSourceEvents.flatMap((event) => (event.skills || []).filter((skill) => skill.score != null).map((skill) => (
              publicSkillRecord(skill, event, privacy.shareEventHistory)
            )))
          : [],
        skillHistory: privacy.shareSkillScores ? publicSkillHistory(skillHistoryFromEvents(skillSourceEvents), privacy.shareEventHistory) : [],
        events: privacy.shareEventHistory
          ? scoredEvents.map(({ skills, crossEventRule, frozenAt, ...event }) => event)
          : [],
        contributions,
      },
    });
  } catch (err) {
    console.error("getPublicDashboardProfile error:", err);
    return res.status(500).json({ ok: false, message: "Profile could not be loaded" });
  }
};

exports.getDashboardPrivacy = async (req, res) => {
  try {
    const student = await Student.findOne({ uid: req.user?.uid }).lean();
    if (!student) return res.status(404).json({ ok: false, message: "Student not found" });
    return res.json({
      ok: true,
      settings: { ...DASHBOARD_PRIVACY_DEFAULTS, ...(student.dashboardPrivacy || {}) },
      hasShareLink: Boolean(student.shareTokenHash) && student.shareTokenRevokedAt == null,
    });
  } catch (err) {
    console.error("getDashboardPrivacy error:", err);
    return res.status(500).json({ ok: false, message: "Failed to load dashboard privacy" });
  }
};

exports.updateDashboardPrivacy = async (req, res) => {
  try {
    const allowed = Object.keys(DASHBOARD_PRIVACY_DEFAULTS);
    const settings = Object.fromEntries(
      allowed.filter((key) => typeof req.body?.[key] === "boolean").map((key) => [key, req.body[key]])
    );
    const student = await Student.findOneAndUpdate(
      { uid: req.user?.uid },
      { $set: Object.fromEntries(Object.entries(settings).map(([key, value]) => [`dashboardPrivacy.${key}`, value])) },
      { new: true }
    ).lean();
    if (!student) return res.status(404).json({ ok: false, message: "Student not found" });
    return res.json({ ok: true, settings: { ...DASHBOARD_PRIVACY_DEFAULTS, ...(student.dashboardPrivacy || {}) } });
  } catch (err) {
    console.error("updateDashboardPrivacy error:", err);
    return res.status(500).json({ ok: false, message: "Failed to update dashboard privacy" });
  }
};

function eventScoreSnapshot(event, participants, submissions) {
  if (event.status === "CLOSED" && event.frozenScores) {
    const frozen = event.frozenScores;
    return {
      ...frozen,
      participants: (frozen.participants || []).map((person) => ({
        ...person,
        email: cleanEmail(person.email),
      })),
    };
  }
  // Student-facing EPA is intentionally unavailable until the authority
  // finalizes the event. The authority preview endpoint is the only place
  // that may score an open event.
  return {
    formulaVersion: FORMULA_VERSION,
    configured: Boolean(event.scoringConfig),
    eligible: event.scoringConfig?.contributesToScoring !== false,
    missing: [],
    scaleMin: null,
    scaleMax: null,
    crossEventRule: "confidence",
    participants: participants.map((person) => ({
      email: person.email,
      eventScore: null,
      confidence: null,
      status: "NO_DATA",
      reason: "awaiting_finalization",
      skills: (event.skills || []).map((skill) => ({ skill, score: null, confidence: null, ratingCount: 0, reason: "awaiting_finalization" })),
    })),
  };
}

function crossEventRuleFor(event, scored) {
  if (event.status === "CLOSED" && event.frozenScores) return scored.crossEventRule ? "confidence" : null;
  return event.scoringConfig ? "confidence" : null;
}

function profileCalculatedAt(events, now = new Date()) {
  let latest = null;
  for (const event of events) {
    const raw = event?.frozenAt;
    if (raw == null || raw === "") return now.toISOString();
    const time = raw instanceof Date ? raw.getTime() : Date.parse(raw);
    if (!Number.isFinite(time)) return now.toISOString();
    if (latest == null || time > latest) latest = time;
  }
  return latest == null ? now.toISOString() : new Date(latest).toISOString();
}

function ratingScale(config) {
  const min = finiteScaleBound(config?.scaleMin);
  const max = finiteScaleBound(config?.scaleMax);
  if (min == null || max == null || min >= max) return null;
  return { min, max };
}

function finiteScaleBound(value) {
  if (value === "" || value == null || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function overallAuditStatus(events) {
  const statuses = (events || [])
    .map((event) => event.auditStatus)
    .filter((status) => ["collecting", "provisional", "final", "recalculation_required"].includes(status));
  if (!statuses.length) return null;
  if (statuses.includes("recalculation_required")) return "recalculation_required";
  if (statuses.includes("provisional")) return "provisional";
  if (statuses.includes("collecting")) return "collecting";
  return "final";
}

function publicSkillRecord(skill, event, shareEventHistory) {
  const record = {
    skill: skill.skill,
    score: skill.score,
    confidence: skill.confidence ?? null,
    scaleMin: event.scaleMin ?? null,
    scaleMax: event.scaleMax ?? null,
  };
  if (shareEventHistory) {
    record.eventId = event.eventId;
    record.eventName = event.eventName;
  }
  return record;
}

function publicSkillHistory(rows, shareEventHistory) {
  if (shareEventHistory) return rows;
  return (rows || []).map((row) => ({
    skill: row.skill,
    direction: row.direction,
    points: (row.points || []).map((point) => ({
      score: point.score,
      confidence: point.confidence ?? null,
      ratingCount: point.ratingCount ?? null,
      scaleMin: point.scaleMin ?? null,
      scaleMax: point.scaleMax ?? null,
    })),
  }));
}

function skillHistoryFromEvents(events) {
  const groups = new Map();
  const ordered = [...(events || [])].sort((left, right) => {
    const leftTime = Date.parse(left.eventDate || "") || 0;
    const rightTime = Date.parse(right.eventDate || "") || 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return String(left.eventId || "").localeCompare(String(right.eventId || ""));
  });
  for (const event of ordered) {
    for (const skill of event.skills || []) {
      if (skill.score === null || skill.score === undefined || skill.score === "") continue;
      const score = Number(skill.score);
      if (!Number.isFinite(score)) continue;
      const key = normalizeLabel(skill.skill);
      if (!key) continue;
      const row = groups.get(key) || { skill: String(skill.skill), points: [] };
      row.skill = String(skill.skill);
      row.points.push({
        eventId: event.eventId,
        eventName: event.eventName,
        eventDate: event.eventDate || null,
        score,
        confidence: skill.confidence ?? null,
        ratingCount: skill.ratingCount ?? null,
        scaleMin: skill.scaleMin ?? event.scaleMin ?? null,
        scaleMax: skill.scaleMax ?? event.scaleMax ?? null,
      });
      groups.set(key, row);
    }
  }
  return [...groups.values()].map((row) => {
    const first = row.points[0].score;
    const last = row.points[row.points.length - 1].score;
    const scaleKey = (point) => `${point.scaleMin}:${point.scaleMax}`;
    const sameScale = row.points.every((point) =>
      point.scaleMin != null && point.scaleMax != null && scaleKey(point) === scaleKey(row.points[0])
    );
    const direction = row.points.length < 2
      ? "single"
      : !sameScale
        ? "mixed_scales"
        : row.points.every((point) => point.score === first)
          ? "flat"
          : last > first
            ? "up"
            : last < first
              ? "down"
              : "varied";
    return { skill: row.skill, direction, points: row.points };
  });
}

function compareLeaderboardRows(left, right) {
  const scoreDelta = Number(right.score) - Number(left.score);
  if (scoreDelta !== 0) return scoreDelta;
  return String(left.name || "").localeCompare(String(right.name || ""), undefined, { sensitivity: "base" });
}

function scaleBound(value) {
  const number = Number(value);
  return Number.isInteger(number) ? String(number) : String(number);
}

function overallScaleBoards(rows) {
  const list = rows || [];
  if (!list.length) return [];
  const groups = new Map();
  for (const row of list) {
    const scaleMin = row.scaleMin == null || !Number.isFinite(Number(row.scaleMin)) ? null : Number(row.scaleMin);
    const scaleMax = row.scaleMax == null || !Number.isFinite(Number(row.scaleMax)) ? null : Number(row.scaleMax);
    const key = `${scaleMin}:${scaleMax}`;
    const group = groups.get(key) || { scaleMin, scaleMax, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    title: groups.size === 1
      ? "Overall"
      : group.scaleMin == null || group.scaleMax == null
        ? "Overall on not set"
        : `Overall on ${scaleBound(group.scaleMin)}–${scaleBound(group.scaleMax)}`,
    scaleMin: group.scaleMin,
    scaleMax: group.scaleMax,
    rows: [...group.rows].sort(compareLeaderboardRows),
  })).sort((left, right) => left.title.localeCompare(right.title));
}

function rankedOverall(rows) {
  const overallBoards = overallScaleBoards(rows);
  return { overall: overallBoards.flatMap((board) => board.rows), overallBoards };
}

function listedSkills(skills) {
  return uniqueSkills(skills);
}

function feedbackWindowState(event, now = new Date()) {
  if (!event || event.status === "CLOSED" || event.closeAtActual) return "closed";
  if (event.openAt && new Date(event.openAt).getTime() > now.getTime()) return "scheduled";
  return "open";
}

function feedbackWindowClosed(event, now = new Date()) {
  return feedbackWindowState(event, now) !== "open";
}

function storedAddress(value) {
  return cleanEmail(value);
}

async function eventsJoinedBy(email) {
  // Keep this query shallow. The old $expr recursively nested a $replaceAll
  // for every whitespace character and could exceed Atlas's 50-level BSON
  // nesting limit before the cursor was initialized.
  const memberships = await Participant.find(emailMatchQuery("email", email)).select("eventId").lean();
  const eventIds = [...new Set(memberships.map((row) => row.eventId).filter(Boolean))];
  if (!eventIds.length) return [];
  // Do not hydrate the unbounded audit-history Mixed field here. Besides not
  // being needed by the dashboard, a malformed/legacy history can exceed
  // MongoDB's 50-level BSON nesting limit while the cursor is decoded.
  return Event.find({ _id: { $in: eventIds }, status: { $in: ["PUBLISHED", "CLOSED"] } })
    .select("name eventStartDate eventDate status openAt closeAtTentative closeAtActual skills scoringConfig frozenScores")
    .lean();
}

function answeredSkill(rating, skill) {
  if (canonicalChoice(rating?.skill, [skill]) !== skill || rating.skipped === true) return false;
  return Number.isFinite(submittedScore(rating?.score));
}

exports.getStudentDashboard = async (req, res) => {
  try {
    const email = storedAddress(req.user?.email);
    if (!email) return res.status(400).json({ ok: false, message: "No email in token" });

    const events = await eventsJoinedBy(email);
    const given = await FeedbackSubmission.find({
      ...emailMatchQuery("raterEmail", email),
      submittedAt: { $ne: null },
    }).select("eventId targetEmail ratings").lean();

    const eventResults = [];
    const pendingFeedback = [];
    let feedbackGiven = 0;
    let feedbackReceived = 0;
    for (const event of events) {
      const eventId = event._id.toString();
      const participantRows = uniqueParticipants(await Participant.find({ eventId }).select("name email level committee").lean());
      const target = participantRows.find((participant) =>
        storedAddress(participant.email) === email
      );
      if (!target) continue;

      const submissions = await FeedbackSubmission.find({
        eventId: event._id,
        submittedAt: { $ne: null },
      }).lean();
      const skillList = listedSkills(event.skills);
      const allowSelf = event.scoringConfig?.allowSelfRatings === true;
      feedbackReceived += submissions.filter((submission) =>
        storedAddress(submission.targetEmail) === email &&
        (allowSelf || storedAddress(submission.raterEmail) !== email) &&
        skillList.length > 0 &&
        skillList.every((skill) => (submission.ratings || []).some((rating) => answeredSkill(rating, skill)))
      ).length;
      const scored = eventScoreSnapshot(event, participantRows, submissions);
      const mine = (scored.participants || []).find((person) => storedAddress(person.email) === email) || {
        eventScore: null,
        confidence: null,
        status: scored.configured === false ? "NOT_CONFIGURED" : "NO_DATA",
        reason: scored.configured === false ? "missing_settings" : "no_ratings",
        skills: [],
      };
      const givenForEvent = given.filter((submission) => String(submission.eventId) === eventId);
      const completedTargets = new Set(
        givenForEvent
          .filter((submission) => (allowSelf || storedAddress(submission.targetEmail) !== email) &&
            skillList.length > 0 &&
            skillList.every((skill) => (submission.ratings || []).some((rating) => answeredSkill(rating, skill))))
          .map((submission) => storedAddress(submission.targetEmail))
      );
      feedbackGiven += completedTargets.size;
      const teammates = participantRows.filter((participant) => allowSelf || storedAddress(participant.email) !== email);
      const feedbackClosed = feedbackWindowClosed(event);
      const canReview = skillList.length > 0 && !feedbackClosed;

      eventResults.push({
        eventId,
        eventName: event.name || "Untitled event",
        eventDate: event.eventStartDate || event.eventDate || null,
        level: target.level || "",
        committee: target.committee || "",
        feedbackGivenCount: completedTargets.size,
        feedbackExpectedCount: skillList.length ? teammates.length : 0,
        feedbackComplete: !skillList.length || teammates.length === 0 || completedTargets.size === teammates.length,
        canReview,
        feedbackWindow: feedbackWindowState(event),
        eventScore: mine.eventScore,
        confidence: mine.confidence ?? null,
        frozenAt: (event.status === "CLOSED" || event.closeAtActual) && scored.frozenAt ? scored.frozenAt : null,
        status: mine.status,
        auditStatus: auditStatus(scored, { closed: event.status === "CLOSED" || Boolean(event.closeAtActual) }),
        reason: mine.reason || null,
        scaleMin: mine.scaleMin ?? scored.scaleMin ?? null,
        scaleMax: mine.scaleMax ?? scored.scaleMax ?? null,
        crossEventRule: crossEventRuleFor(event, scored),
        missing: scored.missing || [],
        skills: mine.skills || [],
        skillScores: Object.fromEntries((mine.skills || []).filter((skill) => skill.score != null).map((skill) => [skill.skill, skill.score])),
        unscoredSkills: (mine.skills || []).filter((skill) => skill.score == null).map((skill) => skill.skill),
        reviewCount: mine.reviewCount ?? null,
        feedback: event.scoringConfig?.showComments === true
          ? submissions
            .filter((submission) => storedAddress(submission.targetEmail) === email)
            .flatMap((submission) =>
              (submission.ratings || [])
                .filter((rating) => rating.comment && !rating.skipped)
                .map((rating) => ({ skill: rating.skill, comment: rating.comment }))
            )
          : [],
      });

      if (canReview) {
        const pendingTeammates = teammates.filter((participant) => !completedTargets.has(storedAddress(participant.email)));
        const unnamedEmails = [...new Set(pendingTeammates
          .filter((participant) => !String(participant.name || "").trim())
          .map((participant) => storedAddress(participant.email))
          .filter(Boolean))];
        const accountNames = new Map();
        if (unnamedEmails.length) {
          const accounts = await Student.find(emailMatchQuery("email", unnamedEmails)).select("email name").lean();
          for (const account of accounts) {
            const accountName = String(account.name || "").trim();
            if (accountName) accountNames.set(storedAddress(account.email), accountName);
          }
        }
        for (const participant of pendingTeammates) {
          const address = storedAddress(participant.email);
          pendingFeedback.push({
            eventId,
            eventName: event.name || "Untitled event",
            targetName: address === email ? "You" : (String(participant.name || "").trim() || accountNames.get(address) || ""),
          });
        }
      }
    }

    const overall = combineOverall(eventResults);
    overall.auditStatus = overallAuditStatus(eventResults);
    return res.json({
      ok: true,
      formulaVersion: FORMULA_VERSION,
      overall,
      skillHistory: skillHistoryFromEvents(eventResults),
      summary: {
        eventsJoined: eventResults.length,
        eventsCompleted: eventResults.filter((event) => event.auditStatus === "final" && Number.isFinite(event.eventScore)).length,
        feedbackGiven,
        feedbackReceived,
        pendingCount: pendingFeedback.length,
      },
      events: eventResults,
      pendingFeedback,
    });
  } catch (err) {
    console.error("getStudentDashboard error:", err);
    return res.status(500).json({ ok: false, message: "Failed to load dashboard" });
  }
};

exports.getLeaderboard = async (req, res) => {
  try {
    const email = storedAddress(req.user?.email);
    if (!email) return res.status(400).json({ ok: false, message: "No email in token" });
    // Keep these lookups shallow. A $expr that nests $replaceAll for every
    // whitespace character exceeds Atlas's BSON nesting limit and the
    // leaderboard request fails before any ranking is returned.
    const student = await Student.findOne(emailMatchQuery("email", email)).select("universityId").lean();
    const universityRaw = student?.universityId || null;
    const memberships = await Participant.find(emailMatchQuery("email", email)).select("eventId").lean();
    const joinedEventIds = [...new Set(memberships.flatMap((row) => {
      if (!row.eventId) return [];
      const asString = String(row.eventId);
      return asString === row.eventId ? [row.eventId] : [row.eventId, asString];
    }))];
    const or = [];
    if (universityRaw) {
      or.push({ universityId: universityRaw });
      const asString = String(universityRaw);
      if (asString !== universityRaw) or.push({ universityId: asString });
    }
    if (joinedEventIds.length) or.push({ _id: { $in: joinedEventIds } });
    const events = or.length
      ? await Event.find({ status: { $in: ["PUBLISHED", "CLOSED"] }, $or: or })
        .select("name status closeAtActual skills scoringConfig frozenScores")
        .lean()
      : [];
    const boards = [];
    const perStudent = new Map();
    const rosterNames = new Map();
    let byEmail = new Map();
    const displayName = (address) => {
      const accountName = String(byEmail.get(address)?.name || "").trim();
      return accountName || rosterNames.get(address) || "Participant";
    };

    for (const event of events) {
      const participants = uniqueParticipants(await Participant.find({ eventId: event._id }).select("email name level committee").lean());
      if (!participants.length) continue;
      for (const person of participants) {
        const rosterName = String(person.name || "").trim();
        if (rosterName && !rosterNames.has(person.email)) rosterNames.set(person.email, rosterName);
      }
      const submissions = await FeedbackSubmission.find({ eventId: event._id, submittedAt: { $ne: null } }).lean();
      const scored = eventScoreSnapshot(event, participants, submissions);
      if (scored.eligible === false) continue;
      const rows = (scored.participants || [])
        .filter((person) => person.eventScore != null)
        .map((person) => ({
          email: person.email,
          score: person.eventScore,
          confidence: person.confidence,
          status: person.status,
          scaleMin: person.scaleMin ?? scored.scaleMin ?? null,
          scaleMax: person.scaleMax ?? scored.scaleMax ?? null,
        }));
      const eventAudit = auditStatus(scored, { closed: event.status === "CLOSED" || Boolean(event.closeAtActual) });
      boards.push({
        eventId: event._id.toString(),
        eventName: event.name || "Untitled event",
        scaleMin: scored.scaleMin ?? null,
        scaleMax: scored.scaleMax ?? null,
        configured: scored.configured !== false,
        auditStatus: eventAudit,
        missing: scored.missing || [],
        rows,
      });
      for (const person of scored.participants || []) {
        const list = perStudent.get(person.email) || [];
        list.push({ ...person, crossEventRule: crossEventRuleFor(event, scored), auditStatus: eventAudit });
        perStudent.set(person.email, list);
      }
    }

    const neededEmails = [...new Set([
      ...boards.flatMap((board) => board.rows.map((row) => row.email)),
      ...perStudent.keys(),
    ])].filter(Boolean);
    const students = neededEmails.length
      ? await Student.find(emailMatchQuery("email", neededEmails)).select("email name photoUrl").lean()
      : [];
    byEmail = new Map(
      students
        .map((account) => [cleanEmail(account.email), account])
        .filter(([address]) => address)
    );

    for (const board of boards) {
      board.rows = board.rows
        .map((row) => {
          const named = { ...row, name: displayName(row.email), photoUrl: byEmail.get(row.email)?.photoUrl || null };
          delete named.email;
          return named;
        })
        .sort(compareLeaderboardRows);
    }

    const overall = [];
    for (const [email, results] of perStudent) {
      const combined = combineOverall(results);
      if (combined.score == null) continue;
      overall.push({
        name: displayName(email),
        photoUrl: byEmail.get(email)?.photoUrl || null,
        score: combined.score,
        confidence: combined.confidence,
        status: combined.status,
        auditStatus: overallAuditStatus(results),
        eventCount: combined.eventCount,
        scaleMin: combined.scaleMin,
        scaleMax: combined.scaleMax,
        rule: combined.rule,
      });
    }
    const ranked = rankedOverall(overall);
    return res.json({ ok: true, formulaVersion: FORMULA_VERSION, overall: ranked.overall, overallBoards: ranked.overallBoards, events: boards });
  } catch (err) {
    console.error("getLeaderboard error:", err);
    return res.status(500).json({ ok: false, message: "Failed to load leaderboard" });
  }
};

exports.registerForEvent = async (req, res) => {
  try {
    const email = storedAddress(req.user?.email);
    if (!email) return res.status(400).json({ ok: false, message: "No email in token" });
    const event = await Event.findById(req.params.eventId, STUDENT_EVENT_READ);
    if (!event || event.status !== "PUBLISHED" || computeEffectiveStatus(event) === "CLOSED") {
      return res.status(404).json({ ok: false, message: "Open event not found" });
    }
    const structure = canonicalEventStructure(event);
    let level = String(req.body?.level || "").trim();
    let committee = String(req.body?.committee || "").trim();
    if (structure.levels?.length) {
      level = canonicalChoice(level, structure.levels);
      if (!level) return res.status(400).json({ ok: false, message: "Choose a level from this event" });
    }
    if ((structure.committees || []).length) {
      committee = canonicalChoice(committee, structure.committees.map((item) => item.name));
      if (!committee) return res.status(400).json({ ok: false, message: "Choose a committee from this event" });
    }
    const committeeRow = (structure.committees || []).find((item) => item.name === committee);
    if (committeeRow?.allowedLevels?.length && !canonicalChoice(level, committeeRow.allowedLevels)) {
      return res.status(400).json({ ok: false, message: "That level is not on the chosen committee" });
    }
    const student = await Student.findOne(emailMatchQuery("email", email)).lean();
    const accountName = String(student?.name || req.user?.name || "").trim();
    const set = { level, committee, email };
    if (accountName) set.name = accountName;
    const existing = await Participant.findOne({
      eventId: event._id,
      ...emailMatchQuery("email", email),
    }).lean();
    if (existing) {
      await Participant.updateOne({ _id: existing._id }, { $set: set });
    } else {
      await Participant.updateOne(
        { eventId: event._id, email },
        {
          $set: set,
          $setOnInsert: { eventId: event._id },
        },
        { upsert: true }
      );
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("registerForEvent error:", err);
    return res.status(500).json({ ok: false, message: "Failed to register" });
  }
};

exports.syncStudent = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const email = storedAddress(req.user?.email) || null;
    const name = req.user?.name || null;
    const provider = req.user?.provider || "firebase";
    const { photoUrl } = req.body || {};

    if (!uid) {
      return res.status(400).json({ message: "uid is required" });
    }

    const setFields = {
      email: email ?? null,
      name: name ?? null,
      provider,
      lastLoginAt: new Date(),
    };
    // only update photoUrl if a real value is provided
    if (photoUrl) setFields.photoUrl = photoUrl;

    const student = await Student.findOneAndUpdate(
      { uid },
      { $set: setFields, $setOnInsert: { uid } },
      { new: true, upsert: true }
    );
    const isProfileComplete =
      !!student.uid &&
      !!student.email &&
      !!student.provider &&
      !!student.universityId &&
      !!(student.name && student.name.trim()) &&
      !!(student.photoUrl && student.photoUrl.trim()) &&
      !!student.dob &&
      !!(student.phone && student.phone.trim());

    return res.status(200).json({
      studentId: student._id.toString(),

      uid: student.uid,
      email: student.email ?? null,
      name: student.name ?? null,
      photoUrl: student.photoUrl ?? null,
      provider: student.provider,

      universityId: student.universityId ? student.universityId.toString() : null,
      universityName: student.universityName ?? null,

      collegeName: student.collegeName ?? null,
      course: student.course ?? null,
      year: student.year ?? null,

      dob: student.dob ?? null,
      phone: student.phone ?? null,
      bio: student.bio ?? null,

      createdAt: student.createdAt,
      updatedAt: student.updatedAt,
      lastLoginAt: student.lastLoginAt,

      isProfileComplete,
    });
  } catch (err) {
    console.error("syncStudent error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const uid = req.user.uid;
    const email = storedAddress(req.user.email);

    const { name, photoUrl, universityId, dob, phone, bio } = req.body;

    // validate required
    if (!name || !name.trim()) {
      return res.status(400).json({ ok: false, message: "Name is required" });
    }

    if (!universityId) {
      return res.status(400).json({ ok: false, message: "University/College is required" });
    }

    if (!photoUrl || !photoUrl.trim()) {
      return res.status(400).json({ ok: false, message: "Profile photo is required" });
    }

    if (!dob) {
      return res.status(400).json({ ok: false, message: "Date of birth is required" });
    }

    const parsedDob = calendarDate(dob);
    if (!parsedDob || parsedDob.invalid) {
      return res.status(400).json({ ok: false, message: "Invalid dob format" });
    }

    const cleanedPhone = String(phone || "").trim();
    if (!/^\d{10}$/.test(cleanedPhone)) {
      return res.status(400).json({ ok: false, message: "Phone must be 10 digits" });
    }

    // validate universityId exists and also cache name
    const uni = await University.findById(universityId);
    if (!uni) {
      return res.status(400).json({ ok: false, message: "Invalid universityId" });
    }

    const cleanedBio = bio ? String(bio).trim() : "";

    const student = await Student.findOneAndUpdate(
      { uid },
      {
        $set: {
          email, // token = source of truth
          name: name.trim(),
          photoUrl: photoUrl.trim(),
          universityId: uni._id,
          universityName: uni.name,
          dob: parsedDob,
          phone: cleanedPhone,
          bio: cleanedBio,
          lastLoginAt: new Date(),
        },
      },
      { new: true }
    );

    if (!student) {
      return res.status(404).json({ ok: false, message: "Student not found" });
    }

    const isProfileComplete =
      !!student.uid &&
      !!student.email &&
      !!student.provider &&
      !!student.universityId &&
      !!(student.name && student.name.trim()) &&
      !!(student.photoUrl && student.photoUrl.trim()) &&
      !!student.dob &&
      !!(student.phone && student.phone.trim());

    return res.status(200).json({
      ok: true,
      studentId: student._id.toString(),

      uid: student.uid,
      email: student.email ?? null,
      name: student.name ?? null,
      photoUrl: student.photoUrl ?? null,
      provider: student.provider,

      universityId: student.universityId ? student.universityId.toString() : null,
      universityName: student.universityName ?? null,

      dob: student.dob ?? null,
      phone: student.phone ?? null,
      bio: student.bio ?? null,

      createdAt: student.createdAt,
      updatedAt: student.updatedAt,
      lastLoginAt: student.lastLoginAt,

      isProfileComplete,
    });
  } catch (err) {
    console.error("updateProfile error:", err);
    return res.status(500).json({ ok: false, message: "Internal server error" });
  }
};

exports.uploadStudentPhoto = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "photo file is required" });
    }

    const uid = req.user.uid;

    const photoUrl = await uploadImage(
      req.file.buffer,
      `${uid}.jpg`,
      `beyond-grades/students/${uid}`,
      512,
      512
    );

    const student = await Student.findOneAndUpdate(
      { uid },
      { $set: { photoUrl } },
      { projection: { photoUrl: 1 }, returnDocument: "before" }
    ).lean();

    const oldUrl = student?.photoUrl;
    if (oldUrl && oldUrl !== photoUrl) {
      deleteCloudinaryUrl(oldUrl).catch(() => {});
    }

    return res.status(200).json({ ok: true, photoUrl });
  } catch (err) {
    console.error("uploadStudentPhoto error:", err);
    return res.status(500).json({ ok: false, message: "Photo upload failed" });
  }
};

exports.skillHistoryFromEvents = skillHistoryFromEvents;
exports.publicSkillRecord = publicSkillRecord;
exports.publicSkillHistory = publicSkillHistory;
exports.compareLeaderboardRows = compareLeaderboardRows;
exports.overallScaleBoards = overallScaleBoards;
exports.rankedOverall = rankedOverall;

exports.getEventDetail = async (req, res) => {
  try {
    const { eventId } = req.params;
    const studentEmail = storedAddress(req.user.email);

    if (!studentEmail) {
      return res.status(400).json({ ok: false, message: "No email in token" });
    }

    const event = await Event.findById(eventId, STUDENT_EVENT_READ);

    if (!event) {
      return res.status(404).json({ ok: false, message: "Event not found" });
    }
    const participant = await Participant.findOne({
      eventId: event._id,
      ...emailMatchQuery("email", studentEmail),
    });

    const feedbackClosed = feedbackWindowClosed(event);
    const hasSkills = Array.isArray(event.skills) && event.skills.some((skill) => String(skill || "").trim());
    const canGiveFeedback = !!participant && !feedbackClosed && hasSkills;
    return res.status(200).json({
      ok: true,
      joined: !!participant,
      feedbackWindow: feedbackWindowState(event),
      item: {
        ...studentVisibleEvent(event),
        effectiveStatus: computeEffectiveStatus(event),
      },
      canGiveFeedback,
    });
  } catch (err) {
    console.error("getEventDetail error:", err);
    return res.status(500).json({ ok: false, message: "Internal server error" });
  }
};

exports.getEventTeam = async (req, res) => {
  try {
    const { eventId } = req.params;
    const raterEmail = req.user.email; // from requireStudent

    if (!raterEmail) {
      return res.status(400).json({ ok: false, message: "No email in token" });
    }

    const event = await Event.findById(eventId, STUDENT_EVENT_READ).lean();
    if (!event) {
      return res.status(404).json({ ok: false, message: "Event not found" });
    }

    const normalizedRaterEmail = storedAddress(raterEmail);
    const raterParticipant = await Participant.findOne({
      eventId: event._id,
      ...emailMatchQuery("email", normalizedRaterEmail),
    }).lean();

    if (!raterParticipant) {
      return res.status(403).json({
        ok: false,
        message: "Only event participants can view the event team",
      });
    }

    // Participants for this event
    const participants = uniqueParticipants(await Participant.find({ eventId: event._id })
      .select("name email rollNumber committee level position")
      .lean());

    const allowSelf = event.scoringConfig?.allowSelfRatings === true;
    const visibleParticipants = participants.filter(
      (p) => allowSelf || storedAddress(p.email) !== normalizedRaterEmail
    );

    const participantEmails = [
      ...new Set(
        visibleParticipants
          .map((p) => storedAddress(p.email))
          .filter(Boolean)
      ),
    ];

    const students = participantEmails.length
      ? await Student.aggregate([
          { $match: emailMatchQuery("email", participantEmails) },
          {
            $project: {
              email: 1,
              name: 1,
              photoUrl: 1,
              bio: 1,
            },
          },
        ])
      : [];

    const studentsByEmail = new Map(
      students.map((student) => [
        storedAddress(student.email),
        student,
      ])
    );

    // All feedback submissions by this rater for this event (fast)
    const submissions = await FeedbackSubmission.find({
      eventId: event._id,
      submittedAt: { $ne: null },
      ...emailMatchQuery("raterEmail", normalizedRaterEmail),
    })
      .select("targetEmail ratings")
      .lean();

    const submissionsByTarget = new Map(
      submissions.map((s) => [storedAddress(s.targetEmail), s])
    );
    const eventSkills = listedSkills(event.skills);

    const items = visibleParticipants.map((p) => {
      const student = studentsByEmail.get(storedAddress(p.email));
      const submission = submissionsByTarget.get(storedAddress(p.email));
      const ratings = Array.isArray(submission?.ratings) ? submission.ratings : [];
      const completedSkills = new Set(
        ratings
          .filter((r) => !r.skipped && Number.isFinite(submittedScore(r.score)))
          .map((r) => canonicalChoice(r.skill, eventSkills))
          .filter(Boolean)
      );
      const pendingSkills = eventSkills.filter((skill) => !completedSkills.has(skill));
      const feedbackComplete = !!submission && eventSkills.length > 0 && pendingSkills.length === 0;

      return {
        name: String(p.name || "").trim() || String(student?.name || "").trim(),
        email: p.email || "",
        rollNumber: p.rollNumber || "",
        committee: p.committee || "",
        level: p.level || "",
        photoUrl: student?.photoUrl || "",
        bio: student?.bio || "",
        roleDescription: p.position || "",
        feedbackGiven: feedbackComplete,
        feedbackComplete,
        pendingSkills,
      };
    });

    return res.status(200).json({
      ok: true,
      event: {
        id: event._id.toString(),
        name: event.name || "",
        skills: eventSkills,
        scaleMin: ratingScale(event.scoringConfig)?.min ?? null,
        scaleMax: ratingScale(event.scoringConfig)?.max ?? null,
        feedbackOpen: !feedbackWindowClosed(event) && eventSkills.length > 0,
        feedbackWindow: feedbackWindowState(event),
        showComments: event.scoringConfig?.showComments === true,
      },
      items,
    });
  } catch (err) {
    console.error("getEventTeam error:", err);
    return res.status(500).json({ ok: false, message: "Internal server error" });
  }
};

function submittedScore(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value === "boolean") return Number.NaN;
  const score = Number(value);
  return Number.isFinite(score) ? score : Number.NaN;
}

exports.submitEventFeedback = async (req, res) => {
  try {
    const { eventId } = req.params;
    const raterEmail = req.user.email;

    const { targetEmail, ratings } = req.body;

    if (!raterEmail) {
      return res.status(400).json({ ok: false, message: "No email in token" });
    }
    if (!targetEmail) {
      return res.status(400).json({ ok: false, message: "targetEmail is required" });
    }
    if (!Array.isArray(ratings)) {
      return res.status(400).json({ ok: false, message: "ratings must be an array" });
    }

    const event = await Event.findById(eventId, STUDENT_EVENT_READ).lean();
    if (!event) {
      return res.status(404).json({ ok: false, message: "Event not found" });
    }
    if (event.status === "CLOSED" || event.closeAtActual) {
      return res.status(403).json({ ok: false, message: "Feedback is closed for this event" });
    }
    if (event.openAt && new Date(event.openAt).getTime() > Date.now()) {
      return res.status(403).json({ ok: false, message: "Feedback is not open yet" });
    }
    const normalizedRaterEmail = storedAddress(raterEmail);
    const normalizedTargetEmail = storedAddress(targetEmail);
    const raterParticipant = await Participant.findOne({
      eventId: event._id,
      ...emailMatchQuery("email", normalizedRaterEmail),
    }).lean();

    if (!raterParticipant) {
      return res.status(403).json({ ok: false, message: "Only event participants can submit feedback" });
    }

    // validate target is participant of this event
    const targetParticipant = await Participant.findOne({
      eventId: event._id,
      ...emailMatchQuery("email", normalizedTargetEmail),
    }).lean();

    if (!targetParticipant) {
      return res.status(400).json({ ok: false, message: "Target is not a participant of this event" });
    }
    if (normalizedRaterEmail === normalizedTargetEmail && event.scoringConfig?.allowSelfRatings !== true) {
      return res.status(403).json({ ok: false, message: "Self ratings are not allowed for this event" });
    }

    const eventSkills = listedSkills(event.skills);

    // Validate ratings against event.skills and the organizer's scale. A skipped skill has no score.
    const sanitized = [];
    const seenSkills = new Set();
    for (const rating of ratings) {
      const submittedSkill = String(rating?.skill || "").trim();
      if (!submittedSkill) {
        return res.status(400).json({ ok: false, message: "Each rating must have a skill" });
      }
      const skill = canonicalChoice(submittedSkill, eventSkills);
      if (!skill) {
        return res.status(400).json({ ok: false, message: `Invalid skill: ${submittedSkill}` });
      }
      if (seenSkills.has(skill)) {
        return res.status(400).json({ ok: false, message: `Each skill can be rated only once: ${skill}` });
      }
      seenSkills.add(skill);
      const r = {
        skill,
        score: submittedScore(rating.score),
        skipped: !!rating.skipped,
        comment: event.scoringConfig?.showComments === true && rating.comment
          ? String(rating.comment).trim()
          : null,
      };
      sanitized.push(r);

      if (r.skipped) {
        if (r.score !== null) {
          return res.status(400).json({ ok: false, message: `Score must be null when skipped for ${r.skill}` });
        }
      } else {
        if (r.score === null || Number.isNaN(r.score)) {
          return res.status(400).json({ ok: false, message: `Score is required for ${r.skill}` });
        }
        const scale = ratingScale(event.scoringConfig);
        if (!scale) {
          return res.status(400).json({ ok: false, message: `Scoring scale is not configured for ${r.skill}` });
        }
        r.score = snapToScale(r.score, scale.min, scale.max);
        if (r.score < scale.min || r.score > scale.max) {
          return res.status(400).json({ ok: false, message: `Score must be ${scale.min}..${scale.max} for ${r.skill}` });
        }
      }
    }

    // prevent duplicates: if already submitted => 409
    const existing = await FeedbackSubmission.findOne({
      eventId: event._id,
      submittedAt: { $ne: null },
      ...emailMatchQuery("raterEmail", normalizedRaterEmail),
      ...emailMatchQuery("targetEmail", normalizedTargetEmail),
    });

    if (existing) {
      const completedSkills = new Set(
        (existing.ratings || [])
          .filter((r) => !r.skipped && Number.isFinite(submittedScore(r.score)))
          .map((r) => canonicalChoice(r.skill, eventSkills))
          .filter(Boolean)
      );
      const hasPendingSkill = eventSkills.some((skill) => !completedSkills.has(skill));

      if (!hasPendingSkill) {
        return res.status(409).json({ ok: false, message: "Feedback already submitted" });
      }

      const ratingsBySkill = new Map();
      for (const rating of existing.ratings || []) {
        const skill = canonicalChoice(rating.skill, eventSkills);
        if (skill) ratingsBySkill.set(skill, { ...rating.toObject?.() || rating, skill });
      }
      sanitized.forEach((rating) => {
        ratingsBySkill.set(rating.skill, rating);
      });

      existing.ratings = eventSkills
        .map((skill) => ratingsBySkill.get(skill))
        .filter(Boolean);
      existing.submittedAt = new Date();
      await existing.save();

      return res.status(200).json({
        ok: true,
        submissionId: existing._id.toString(),
        submittedAt: existing.submittedAt,
      });
    }

    // Create submission (locked immediately for MVP)
    const doc = await FeedbackSubmission.create({
      eventId: event._id,
      raterEmail: normalizedRaterEmail,
      targetEmail: normalizedTargetEmail,
      ratings: sanitized,
      submittedAt: new Date(),
    });

    return res.status(200).json({
      ok: true,
      submissionId: doc._id.toString(),
      submittedAt: doc.submittedAt,
    });
  } catch (err) {
    // Handle unique index conflict as 409 too
    if (err && err.code === 11000) {
      return res.status(409).json({ ok: false, message: "Feedback already submitted" });
    }

    console.error("submitEventFeedback error:", err);
    return res.status(500).json({ ok: false, message: "Internal server error" });
  }
};
