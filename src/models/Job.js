const mongoose = require("mongoose");

const JobSchema = new mongoose.Schema(
  {
    startupId: { type: mongoose.Schema.Types.ObjectId, ref: "Startup", required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    open: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Job", JobSchema);
