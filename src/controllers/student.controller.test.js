const assert = require("assert");
const test = require("node:test");

const Event = require("../models/Event");
const FeedbackSubmission = require("../models/FeedbackSubmission");
const Participant = require("../models/Participant");
const Student = require("../models/Student");

process.env.DO_SPACES_ENDPOINT ||= "https://example.com";

const { getEventDetail, getEventTeam, syncStudent } = require("./student.controller");

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
    participantFindOne: Participant.findOne,
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

    Participant.findOne = () => ({
      lean: async () => ({
        email: "rater@example.com",
      }),
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
    Participant.findOne = originals.participantFindOne;
    Participant.find = originals.participantFind;
    Student.aggregate = originals.studentAggregate;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("getEventTeam excludes the current rater and exposes pending skipped skills", async () => {
  const originals = {
    eventFindById: Event.findById,
    participantFindOne: Participant.findOne,
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

    Participant.findOne = () => ({
      lean: async () => ({
        email: "rater@example.com",
      }),
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
    Participant.findOne = originals.participantFindOne;
    Participant.find = originals.participantFind;
    Student.aggregate = originals.studentAggregate;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("syncStudent uses verified token identity instead of request body identity", async () => {
  const originalFindOneAndUpdate = Student.findOneAndUpdate;

  try {
    Student.findOneAndUpdate = async (filter, update) => {
      assert.deepStrictEqual(filter, { uid: "verified-uid" });
      assert.strictEqual(update.$set.email, "verified@example.com");
      assert.strictEqual(update.$set.name, "Verified User");
      assert.strictEqual(update.$set.provider, "google.com");
      assert.deepStrictEqual(update.$setOnInsert, { uid: "verified-uid" });

      return {
        _id: { toString: () => "student-id" },
        uid: filter.uid,
        email: update.$set.email,
        name: update.$set.name,
        photoUrl: "",
        provider: update.$set.provider,
        universityId: null,
        universityName: null,
        collegeName: null,
        course: null,
        year: null,
        dob: null,
        phone: "",
        bio: "",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastLoginAt: update.$set.lastLoginAt,
      };
    };

    const req = {
      body: {
        uid: "spoofed-uid",
        email: "spoofed@example.com",
        name: "Spoofed User",
        provider: "password",
      },
      user: {
        uid: "verified-uid",
        email: "verified@example.com",
        name: "Verified User",
        provider: "google.com",
      },
    };
    const res = createResponse();

    await syncStudent(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.uid, "verified-uid");
    assert.strictEqual(res.body.email, "verified@example.com");
  } finally {
    Student.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("getEventTeam rejects students who are not event participants", async () => {
  const originals = {
    eventFindById: Event.findById,
    participantFindOne: Participant.findOne,
    participantFind: Participant.find,
    studentAggregate: Student.aggregate,
    feedbackFind: FeedbackSubmission.find,
  };

  try {
    Event.findById = () => ({
      lean: async () => ({
        _id: { toString: () => "64f000000000000000000001" },
        name: "Launch Fest",
        skills: ["Planning"],
      }),
    });
    Participant.findOne = () => ({ lean: async () => null });
    Participant.find = () => {
      throw new Error("Participant list should not be queried for non-participants");
    };
    Student.aggregate = async () => {
      throw new Error("Students should not be queried for non-participants");
    };
    FeedbackSubmission.find = () => {
      throw new Error("Feedback should not be queried for non-participants");
    };

    const req = {
      params: { eventId: "64f000000000000000000001" },
      user: { email: "outsider@example.com" },
    };
    const res = createResponse();

    await getEventTeam(req, res);

    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, {
      ok: false,
      message: "Only event participants can view the event team",
    });
  } finally {
    Event.findById = originals.eventFindById;
    Participant.findOne = originals.participantFindOne;
    Participant.find = originals.participantFind;
    Student.aggregate = originals.studentAggregate;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("getEventDetail loads published event details for students who are not participants", async () => {
  const originals = {
    eventFindById: Event.findById,
    participantFindOne: Participant.findOne,
  };

  try {
    Event.findById = async () => ({
      _id: { toString: () => "64f000000000000000000001" },
      name: "Launch Fest",
      status: "PUBLISHED",
      eventStartDate: new Date("2026-05-10T10:00:00.000Z"),
      eventEndDate: new Date("2026-05-11T10:00:00.000Z"),
      toObject() {
        return {
          _id: this._id,
          name: this.name,
          status: this.status,
          eventStartDate: this.eventStartDate,
          eventEndDate: this.eventEndDate,
        };
      },
    });
    Participant.findOne = async () => null;

    const req = {
      params: { eventId: "64f000000000000000000001" },
      user: { email: "outsider@example.com" },
    };
    const res = createResponse();

    await getEventDetail(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.canGiveFeedback, false);
    assert.strictEqual(res.body.item.name, "Launch Fest");
    assert.strictEqual(res.body.item.effectiveStatus, "SCHEDULED");
  } finally {
    Event.findById = originals.eventFindById;
    Participant.findOne = originals.participantFindOne;
  }
});

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.statusCode ||= 200;
      this.body = payload;
      return this;
    },
  };
}
