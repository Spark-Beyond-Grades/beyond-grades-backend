const mongoose = require("mongoose");

const universitySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true }
  },
  { timestamps: true }
);

// Helps case-insensitive uniqueness by storing normalized name
universitySchema.pre("save", function (next) {
  this.name = this.name.trim();
  next();
});

module.exports = mongoose.model("University", universitySchema);