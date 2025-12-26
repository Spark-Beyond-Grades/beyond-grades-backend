const mongoose = require("mongoose");

const AuthoritySchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String },
    role: { type: String, enum: ["ADMIN", "AUTHORITY"], default: "AUTHORITY" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Authority", AuthoritySchema);