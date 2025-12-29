const mongoose = require("mongoose");

const ParticipantSchema = new mongoose.Schema(
  {
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true, index: true },

    name: { type: String, trim: true, default: "" },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    rollNumber: { type: String, trim: true, default: "" },

    committee: { type: String, trim: true, default: "" },
    level: { type: String, trim: true, default: "" },
    position: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

// prevent duplicate email per event
ParticipantSchema.index({ eventId: 1, email: 1 }, { unique: true });

module.exports = mongoose.model("Participant", ParticipantSchema);