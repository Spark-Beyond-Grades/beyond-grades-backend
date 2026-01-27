const mongoose = require("mongoose");

const SkillRatingSchema = new mongoose.Schema(
  {
    skill: { type: String, required: true, trim: true },
    score: { type: Number, default: null }, // null when skipped
    skipped: { type: Boolean, default: false },
    comment: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const FeedbackSubmissionSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },

    raterEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    targetEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    ratings: { type: [SkillRatingSchema], default: [] },

    submittedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Unique: one submission per rater per target per event
FeedbackSubmissionSchema.index(
  { eventId: 1, raterEmail: 1, targetEmail: 1 },
  { unique: true }
);

module.exports = mongoose.model("FeedbackSubmission", FeedbackSubmissionSchema);