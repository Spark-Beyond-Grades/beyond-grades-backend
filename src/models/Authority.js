const mongoose = require("mongoose");

const AuthoritySchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String },
    role: { type: String, enum: ["ADMIN", "AUTHORITY"], default: "AUTHORITY" },
    isActive: { type: Boolean, default: true },
    groupId: { type: String, required: true, index: true },
    universityId: { type: mongoose.Schema.Types.ObjectId, ref: "University", default: null, index: true },
    universityName: { type: String, default: null } // optional cache

  },
  { timestamps: true }
);

module.exports = mongoose.model("Authority", AuthoritySchema);