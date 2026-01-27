const Student = require("../models/Student");
const Participant = require("../models/Participant");
const University = require("../models/University");
const FeedbackSubmission = require("../models/FeedbackSubmission");
const Event = require("../models/Event");

exports.syncStudent = async (req, res) => {
  try {
    const { uid, email, name, photoUrl, provider } = req.body;

    if (!uid || !provider) {
      return res.status(400).json({ message: "uid and provider are required" });
    }

    const student = await Student.findOneAndUpdate(
      { uid },
      {
        $set: {
          email: email ?? null,
          name: name ?? null,
          photoUrl: photoUrl ?? null,
          provider,
          lastLoginAt: new Date(),
        },
        $setOnInsert: { uid },
      },
      { new: true, upsert: true }
    );
    const isProfileComplete =
      !!student.uid &&
      !!student.email &&
      !!student.provider &&
      !!student.universityId;

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
    const { uid, name, photoUrl, collegeName, course, year, universityId } = req.body;

    let uni = null;
    if (universityId) {
      uni = await University.findById(universityId);
      if (!uni) {
        return res.status(400).json({ message: "Invalid universityId" });
      }
    }

    const student = await Student.findOneAndUpdate(
      { uid },
      {
        $set: {
          name: name ?? null,
          photoUrl: photoUrl ?? null,
          collegeName: collegeName ?? null,
          course: course ?? null,
          year: year ?? null,
          universityId: uni ? uni._id : null,
          universityName: uni ? uni.name : null,
          lastLoginAt: new Date()
        }
      },
      { new: true }
    );

    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    const isProfileComplete =
      !!student.uid &&
      !!student.email &&
      !!student.provider &&
      !!student.universityId;

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

      createdAt: student.createdAt,
      updatedAt: student.updatedAt,
      lastLoginAt: student.lastLoginAt,

      isProfileComplete
    });
  } catch (err) {
    console.error("updateProfile error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getEventDetail = async (req, res) => {
  try {
    const { eventId } = req.params;
    const studentEmail = req.user.email;

    const event = await Event.findById(eventId);

    if (!event) {
      return res.status(404).json({ ok: false, message: "Event not found" });
    }
    const participant = await Participant.findOne({
      eventId: event._id,
      email: studentEmail,
    });

    return res.status(200).json({ ok: true, item: event,canGiveFeedback: !!participant });
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

    const event = await Event.findById(eventId).lean();
    if (!event) {
      return res.status(404).json({ ok: false, message: "Event not found" });
    }

    // Participants for this event
    const participants = await Participant.find({ eventId: event._id })
      .select("name email rollNumber committee level")
      .lean();

    // All feedback submissions by this rater for this event (fast)
    const submissions = await FeedbackSubmission.find({
      eventId: event._id,
      raterEmail,
      submittedAt: { $ne: null },
    })
      .select("targetEmail")
      .lean();

    const submittedTargets = new Set(submissions.map((s) => s.targetEmail));

    const items = participants.map((p) => ({
      name: p.name || "",
      email: p.email || "",
      rollNumber: p.rollNumber || "",
      committee: p.committee || "",
      level: p.level || "",
      feedbackGiven: submittedTargets.has(p.email),
    }));

    return res.status(200).json({
      ok: true,
      event: {
        id: event._id.toString(),
        name: event.name || "",
        skills: Array.isArray(event.skills) ? event.skills : [],
      },
      items,
    });
  } catch (err) {
    console.error("getEventTeam error:", err);
    return res.status(500).json({ ok: false, message: "Internal server error" });
  }
};

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

    const event = await Event.findById(eventId).lean();
    if (!event) {
      return res.status(404).json({ ok: false, message: "Event not found" });
    }

    const eventSkills = Array.isArray(event.skills) ? event.skills : [];

    // validate target is participant of this event
    const targetParticipant = await Participant.findOne({
      eventId: event._id,
      email: targetEmail.toLowerCase().trim(),
    }).lean();

    if (!targetParticipant) {
      return res.status(400).json({ ok: false, message: "Target is not a participant of this event" });
    }

    // Validate ratings against event.skills
    // Allow only skills from eventSkills; score must be 0..10 if not skipped; if skipped, score must be null.
    const sanitized = ratings.map((r) => ({
      skill: (r.skill || "").trim(),
      score: r.score === null || r.score === undefined ? null : Number(r.score),
      skipped: !!r.skipped,
      comment: r.comment ? String(r.comment).trim() : null,
    }));

    for (const r of sanitized) {
      if (!r.skill) {
        return res.status(400).json({ ok: false, message: "Each rating must have a skill" });
      }
      if (!eventSkills.includes(r.skill)) {
        return res.status(400).json({ ok: false, message: `Invalid skill: ${r.skill}` });
      }

      if (r.skipped) {
        if (r.score !== null) {
          return res.status(400).json({ ok: false, message: `Score must be null when skipped for ${r.skill}` });
        }
      } else {
        if (r.score === null || Number.isNaN(r.score)) {
          return res.status(400).json({ ok: false, message: `Score is required for ${r.skill}` });
        }
        if (r.score < 0 || r.score > 10) {
          return res.status(400).json({ ok: false, message: `Score must be 0..10 for ${r.skill}` });
        }
      }
    }

    // prevent duplicates: if already submitted => 409
    const existing = await FeedbackSubmission.findOne({
      eventId: event._id,
      raterEmail: raterEmail.toLowerCase().trim(),
      targetEmail: targetEmail.toLowerCase().trim(),
      submittedAt: { $ne: null },
    }).lean();

    if (existing) {
      return res.status(409).json({ ok: false, message: "Feedback already submitted" });
    }

    // Create submission (locked immediately for MVP)
    const doc = await FeedbackSubmission.create({
      eventId: event._id,
      raterEmail: raterEmail.toLowerCase().trim(),
      targetEmail: targetEmail.toLowerCase().trim(),
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
