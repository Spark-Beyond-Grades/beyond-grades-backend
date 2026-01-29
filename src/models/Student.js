const mongoose = require("mongoose");

const studentSchema = new mongoose.Schema(
  {
    uid: { type: String, required: true, unique: true, index: true },

    email: { type: String },
    name: { type: String },
    photoUrl: { type: String, trim: true, default: "" },

    provider: { type: String, required: true }, // "google" | "microsoft"

    collegeName: { type: String },
    course: { type: String },
    year: { type: Number },
    universityId: { type: mongoose.Schema.Types.ObjectId, ref: "University", default: null },
    universityName: { type: String, default: null },

    dob: { type: Date, default: null },
    phone: { type: String, trim: true, default: "" },
    bio: { type: String, trim: true, default: "" },

    lastLoginAt: { type: Date, default: Date.now }
  },
  { timestamps: true } // createdAt, updatedAt
);

module.exports = mongoose.model("Student", studentSchema);