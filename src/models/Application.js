const mongoose = require("mongoose");

const ApplicationSchema = new mongoose.Schema(
  {
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    message: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

ApplicationSchema.index({ jobId: 1, email: 1 }, { unique: true });

module.exports = mongoose.model("Application", ApplicationSchema);
