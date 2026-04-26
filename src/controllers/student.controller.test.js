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
          ratings: [{ skill: "Planning", score: 8, skipped: false, comment: null }],
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
        feedbackComplete: true,
        pendingSkills: [],
      },
    ]);
  } finally {
    Event.findById = originals.eventFindById;
    Participant.find = originals.participantFind;
    Student.aggregate = originals.studentAggregate;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("getEventTeam excludes the current rater and exposes pending skipped skills", async () => {
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
    skills: ["Planning", "Leadership"],
  };

  try {
    Event.findById = () => ({
      lean: async () => event,
    });

    Participant.find = () =>
      queryResult([
        {
          name: "Current User",
          email: "rater@example.com",
          rollNumber: "BG000",
          committee: "Ops",
          level: "Lead",
          position: "",
        },
        {
          name: "Asha Rao",
          email: "asha@example.com",
          rollNumber: "BG001",
          committee: "Ops",
          level: "Lead",
          position: "",
        },
      ]);

    Student.aggregate = async () => [];

    FeedbackSubmission.find = () =>
      queryResult([
        {
          targetEmail: "asha@example.com",
          ratings: [
            { skill: "Planning", score: 8, skipped: false, comment: null },
            { skill: "Leadership", score: null, skipped: true, comment: null },
          ],
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
    assert.strictEqual(res.body.items.length, 1);
    assert.strictEqual(res.body.items[0].email, "asha@example.com");
    assert.strictEqual(res.body.items[0].feedbackGiven, false);
    assert.strictEqual(res.body.items[0].feedbackComplete, false);
    assert.deepStrictEqual(res.body.items[0].pendingSkills, ["Leadership"]);
  } finally {
    Event.findById = originals.eventFindById;
    Participant.find = originals.participantFind;
    Student.aggregate = originals.studentAggregate;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});
