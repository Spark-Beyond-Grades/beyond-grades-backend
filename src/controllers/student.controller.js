const Student = require("../models/Student");
const Participant = require("../models/Participant");
const University = require("../models/University");
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