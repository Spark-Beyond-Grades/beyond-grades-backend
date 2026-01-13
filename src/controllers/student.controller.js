const Student = require("../models/Student");

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
      !!student.collegeName; // this is the gate field

    return res.status(200).json({
      studentId: student._id.toString(),

      uid: student.uid,
      email: student.email ?? null,
      name: student.name ?? null,
      photoUrl: student.photoUrl ?? null,
      provider: student.provider,

      // 👇 A1 fields (profile completion fields)
      collegeName: student.collegeName ?? null,
      course: student.course ?? null,
      year: student.year ?? null,

      // 👇 timestamps (from mongoose)
      createdAt: student.createdAt,
      updatedAt: student.updatedAt,
      lastLoginAt: student.lastLoginAt,

      // 👇 A2 flag
      isProfileComplete,
    });
  } catch (err) {
    console.error("syncStudent error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const { uid, name, photoUrl, collegeName, course, year } = req.body;

    if (!uid) {
      return res.status(400).json({ message: "uid is required" });
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
      !!student.collegeName;

    return res.status(200).json({
      studentId: student._id.toString(),

      uid: student.uid,
      email: student.email ?? null,
      name: student.name ?? null,
      photoUrl: student.photoUrl ?? null,
      provider: student.provider,

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
