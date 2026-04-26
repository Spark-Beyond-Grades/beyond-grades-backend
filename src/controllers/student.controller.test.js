const assert = require("assert");
const test = require("node:test");

const Event = require("../models/Event");
const FeedbackSubmission = require("../models/FeedbackSubmission");
const Participant = require("../models/Participant");
const Student = require("../models/Student");

process.env.DO_SPACES_ENDPOINT ||= "https://example.com";

const { getEventTeam } = require("./student.controller");

function queryResult(rows) {
  return {
    select() {
      return this;
    },
    lean: async () => rows,
  };
}

test("getEventTeam returns matched student photo, bio, and participant role description", async () => {
  const originals = {
    eventFindById: Event.findById,
    participantFind: Participant.find,
    studentAggregate: Student.aggregate,
    feedbackFind: FeedbackSubmission.find,
  };

  const eventId = "64f000000000000000000001";
  const event = {
    _id: {
      toString: () => eventId,
    },
    name: "Launch Fest",
    skills: ["Planning"],
  };

  try {
    Event.findById = () => ({
      lean: async () => event,
    });

    Participant.find = () =>
      queryResult([
        {
          name: "Asha Rao",
          email: "asha@example.com",
          rollNumber: "BG001",
          committee: "Ops",
          level: "Lead",
          position: "Coordinated venue and check-in",
        },
      ]);

    Student.aggregate = async () => [
      {
        email: "ASHA@example.com",
        photoUrl: "https://cdn.example.com/asha.jpg",
        bio: "Builds student events.",
      },
    ];

    FeedbackSubmission.find = () =>
      queryResult([
        {
          targetEmail: "asha@example.com",
        },
      ]);

    const req = {
      params: { eventId },
      user: { email: "rater@example.com" },
    };
    const res = {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };

    await getEventTeam(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.items, [
      {
        name: "Asha Rao",
        email: "asha@example.com",
        rollNumber: "BG001",
        committee: "Ops",
        level: "Lead",
        photoUrl: "https://cdn.example.com/asha.jpg",
        bio: "Builds student events.",
        roleDescription: "Coordinated venue and check-in",
        feedbackGiven: true,
      },
    ]);
  } finally {
    Event.findById = originals.eventFindById;
    Participant.find = originals.participantFind;
    Student.aggregate = originals.studentAggregate;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});
