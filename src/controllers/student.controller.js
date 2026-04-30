const Student = require("../models/Student");
const Participant = require("../models/Participant");
const University = require("../models/University");
const FeedbackSubmission = require("../models/FeedbackSubmission");
const Event = require("../models/Event");
const { s3 } = require("../config/spaces");
const sharp = require("sharp");
const { PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

exports.syncStudent = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const email = req.user?.email || null;
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
    const email = req.user.email;

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

    const parsedDob = new Date(dob);
    if (Number.isNaN(parsedDob.getTime())) {
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
    const cdnBase = process.env.DO_SPACES_CDN_BASE;
    const bucket = process.env.DO_SPACES_BUCKET;

    // compress + resize (safe defaults)
    const compressed = await sharp(req.file.buffer)
      .resize(512, 512, { fit: "cover" })
      .jpeg({ quality: 75 })
      .toBuffer();

    const key = `students/${uid}/${Date.now()}.jpg`;

    // ── 1. Upload the NEW photo first ──
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: compressed,
        ACL: "public-read",
        ContentType: "image/jpeg",
      })
    );

    const photoUrl = `${cdnBase}/${key}`;

    // ── 2. Grab old URL and persist the new one to DB ──
    const student = await Student.findOneAndUpdate(
      { uid },
      { $set: { photoUrl } },
      { projection: { photoUrl: 1 }, returnDocument: "before" }
    ).lean();

    // ── 3. NOW it's safe to delete the old photo (if it's ours) ──
    const oldUrl = student?.photoUrl;
    if (oldUrl && cdnBase && oldUrl.startsWith(cdnBase)) {
      const oldKey = oldUrl.replace(`${cdnBase}/`, "");
      s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey })).catch((err) =>
        console.warn("Failed to delete old photo:", err.message)
      );
    }

    return res.status(200).json({ ok: true, photoUrl });
  } catch (err) {
    console.error("uploadStudentPhoto error:", err);
    return res.status(500).json({ ok: false, message: "Photo upload failed" });
  }
};

exports.getEventDetail = async (req, res) => {
  try {
    const { eventId } = req.params;
    const studentEmail = (req.user.email || "").toLowerCase().trim();

    if (!studentEmail) {
      return res.status(400).json({ ok: false, message: "No email in token" });
    }

    const event = await Event.findById(eventId);

    if (!event) {
      return res.status(404).json({ ok: false, message: "Event not found" });
    }
    const participant = await Participant.findOne({
      eventId: event._id,
      email: studentEmail,
    });

    if (!participant) {
      return res.status(403).json({
        ok: false,
        message: "Only event participants can view event details",
      });
    }

    return res.status(200).json({ ok: true, item: event, canGiveFeedback: true });
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

    const raterParticipant = await Participant.findOne({
      eventId: event._id,
      email: raterEmail.toLowerCase().trim(),
    }).lean();

    if (!raterParticipant) {
      return res.status(403).json({
        ok: false,
        message: "Only event participants can view the event team",
      });
    }

    // Participants for this event
    const participants = await Participant.find({ eventId: event._id })
      .select("name email rollNumber committee level position")
      .lean();

    const normalizedRaterEmail = raterEmail.toLowerCase().trim();
    const visibleParticipants = participants.filter(
      (p) => (p.email || "").toLowerCase().trim() !== normalizedRaterEmail
    );

    const participantEmails = [
      ...new Set(
        visibleParticipants
          .map((p) => (p.email || "").toLowerCase().trim())
          .filter(Boolean)
      ),
    ];

    const students = participantEmails.length
      ? await Student.aggregate([
          {
            $match: {
              $expr: {
                $in: [
                  {
                    $toLower: {
                      $trim: {
                        input: { $ifNull: ["$email", ""] },
                      },
                    },
                  },
                  participantEmails,
                ],
              },
            },
          },
          {
            $project: {
              email: 1,
              photoUrl: 1,
              bio: 1,
            },
          },
        ])
      : [];

    const studentsByEmail = new Map(
      students.map((student) => [
        (student.email || "").toLowerCase().trim(),
        student,
      ])
    );

    // All feedback submissions by this rater for this event (fast)
    const submissions = await FeedbackSubmission.find({
      eventId: event._id,
      raterEmail,
      submittedAt: { $ne: null },
    })
      .select("targetEmail ratings")
      .lean();

    const submissionsByTarget = new Map(
      submissions.map((s) => [(s.targetEmail || "").toLowerCase().trim(), s])
    );
    const eventSkills = Array.isArray(event.skills) ? event.skills : [];

    const items = visibleParticipants.map((p) => {
      const student = studentsByEmail.get((p.email || "").toLowerCase().trim());
      const submission = submissionsByTarget.get((p.email || "").toLowerCase().trim());
      const ratings = Array.isArray(submission?.ratings) ? submission.ratings : [];
      const completedSkills = new Set(
        ratings
          .filter((r) => !r.skipped && r.score !== null && r.score !== undefined)
          .map((r) => r.skill)
      );
      const pendingSkills = eventSkills.filter((skill) => !completedSkills.has(skill));
      const feedbackComplete = !!submission && eventSkills.length > 0 && pendingSkills.length === 0;

      return {
        name: p.name || "",
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

    const raterParticipant = await Participant.findOne({
      eventId: event._id,
      email: raterEmail.toLowerCase().trim(),
    }).lean();

    if (!raterParticipant) {
      return res.status(403).json({ ok: false, message: "Only event participants can submit feedback" });
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
    });

    if (existing) {
      const completedSkills = new Set(
        (existing.ratings || [])
          .filter((r) => !r.skipped && r.score !== null && r.score !== undefined)
          .map((r) => r.skill)
      );
      const hasPendingSkill = eventSkills.some((skill) => !completedSkills.has(skill));

      if (!hasPendingSkill) {
        return res.status(409).json({ ok: false, message: "Feedback already submitted" });
      }

      const ratingsBySkill = new Map((existing.ratings || []).map((r) => [r.skill, r]));
      sanitized.forEach((rating) => {
        ratingsBySkill.set(rating.skill, rating);
      });

      existing.ratings = eventSkills.map(
        (skill) => ratingsBySkill.get(skill) || { skill, score: null, skipped: true, comment: null }
      );
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
