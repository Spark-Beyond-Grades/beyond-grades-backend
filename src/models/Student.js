const mongoose = require("mongoose");

const studentSchema = new mongoose.Schema(
  {
    uid: { type: String, required: true, unique: true, index: true },

    email: { type: String },
    name: { type: String },
    photoUrl: { type: String },

    provider: { type: String, required: true }, // "google" | "microsoft"

    collegeName: { type: String },
    course: { type: String },
    year: { type: Number },

    lastLoginAt: { type: Date, default: Date.now }
  },
  { timestamps: true } // createdAt, updatedAt
);

module.exports = mongoose.model("Student", studentSchema);