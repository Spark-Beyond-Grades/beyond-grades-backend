const mongoose = require("mongoose");

const EventSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },
    type: {
      type: String,
      enum: ["CLUB", "PROJECT", "FEST", "COMMITTEE", "OTHER"],
      default: "OTHER",
    },

    createdByEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },

    // Manual status (stored)
    status: {
      type: String,
      enum: ["DRAFT", "PUBLISHED", "CLOSED"],
      default: "DRAFT",
    },

    // Dates (stored)
    openAt: { type: Date, default: null },
    closeAtTentative: { type: Date, default: null },
    closeAtActual: { type: Date, default: null },

    // Step 3.3 - Team Structure
    levels: { type: [String], default: [] },
    skills: { type: [String], default: [] },
    
    committees: {
      type: [
        {
          name: { type: String, required: true, trim: true },
          allowedLevels: { type: [String], default: [] },
        },
      ],
      default: [],
    },
    groupId: { type: String, required: true, index: true },
    universityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "University",
      required: true,
      index: true
    },
    universityName: { type: String, default: null } // optional cache

  },
  { timestamps: true },
);

module.exports = mongoose.model("Event", EventSchema);
