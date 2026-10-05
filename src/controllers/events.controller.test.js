const assert = require("assert");
const test = require("node:test");
const mongoose = require("mongoose");

process.env.CLOUDINARY_URL ||= "cloudinary://key:secret@example";

const Event = require("../models/Event");
const Participant = require("../models/Participant");
const FeedbackSubmission = require("../models/FeedbackSubmission");
const Student = require("../models/Student");

const Authority = require("../models/Authority");
const University = require("../models/University");
const { getStudentFeed, listEvents, publishEvent, deleteEvent, recalculateEventScores, uploadParticipantsCsv, removeParticipant, closeEvent, previewEventScores, getFeedbackSummary, getSuggestions, updateEvent, getEventById, getParticipants, uploadEventPoster, uploadEventLogo } = require("./events.controller");

const HOME_UNIVERSITY_ID = "64f000000000000000000001";
const OUTSIDE_UNIVERSITY_ID = "64f000000000000000000002";

test("listEvents shows the start date when the legacy date field is empty", async () => {
  const originalEventFind = Event.find;
  const start = new Date("2026-06-02T00:00:00.000Z");
  try {
    Event.find = () => ({
      sort() {
        return [{
          name: "Launch Fest",
          status: "PUBLISHED",
          eventDate: null,
          eventStartDate: start,
          toObject() {
            return { name: this.name, status: this.status, eventDate: this.eventDate, eventStartDate: this.eventStartDate };
          },
        }];
      },
    });
    const response = createResponse();
    await listEvents({ user: { groupId: "authority-group" } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(new Date(response.body.events[0].eventDate).toISOString(), start.toISOString());
  } finally {
    Event.find = originalEventFind;
  }
});

test("listEvents returns draft and published authority events for the group", async () => {
  const originalEventFind = Event.find;

  try {
    const rows = [
      authorityEventRecord("64f000000000000000000021", "Draft setup", "DRAFT"),
      authorityEventRecord("64f000000000000000000022", "Live event", "PUBLISHED"),
    ];

    Event.find = (filter, projection) => {
      assert.deepStrictEqual(filter, { groupId: "authority-group" });
      assert.equal(projection.frozenScoreHistory, 0);
      return {
        sort(sort) {
          assert.deepStrictEqual(sort, { createdAt: -1 });
          return rows;
        },
      };
    };

    const res = createResponse();

    await listEvents({ user: { groupId: "authority-group" } }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(
      res.body.events.map((event) => [event.name, event.status, event.effectiveStatus]),
      [
        ["Draft setup", "DRAFT", "DRAFT"],
        ["Live event", "PUBLISHED", "PUBLISHED"],
      ],
    );
  } finally {
    Event.find = originalEventFind;
  }
});

test("getStudentFeed uses verified user uid instead of query uid", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    eventFind: Event.find,
  };

  try {
    Student.findOne = async (filter) => {
      assert.deepStrictEqual(filter, { uid: "verified-uid" });
      return {
        universityId: {
          toString: () => "64f000000000000000000001",
        },
      };
    };

    Event.find = (filter, projection) => {
      assert.strictEqual(filter.status, "PUBLISHED");
      assert.deepStrictEqual(filter.$nor, [{ closeAtActual: { $exists: true, $ne: null } }]);
      assert.strictEqual(projection.frozenScoreHistory, 0);
      assert.strictEqual(projection.scoringConfig, 0);
      assert.strictEqual(projection.frozenScores, 0);
      return {
        sort() {
          return this;
        },
        limit: async () => [],
      };
    };

    const req = {
      query: { uid: "spoofed-uid" },
      user: { uid: "verified-uid" },
    };
    const res = createResponse();

    await getStudentFeed(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.items, []);
    assert.strictEqual(res.body.studentUniversityId, "64f000000000000000000001");
  } finally {
    Student.findOne = originals.studentFindOne;
    Event.find = originals.eventFind;
  }
});

test("getStudentFeed returns the first cursor page with pagination metadata", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    eventFind: Event.find,
  };

  try {
    Student.findOne = async () => studentRecord(HOME_UNIVERSITY_ID);

    const rows = [
      eventRecord("64f000000000000000000011", "Newest", "2026-04-28T10:00:00.000Z", HOME_UNIVERSITY_ID),
      eventRecord("64f000000000000000000012", "Second", "2026-04-28T09:00:00.000Z", OUTSIDE_UNIVERSITY_ID),
      eventRecord("64f000000000000000000013", "Extra", "2026-04-28T08:00:00.000Z", OUTSIDE_UNIVERSITY_ID),
    ];

    Event.find = (filter) => {
      assert.strictEqual(filter.status, "PUBLISHED");
      assert.deepStrictEqual(filter.$nor, [{ closeAtActual: { $exists: true, $ne: null } }]);
      return queryChain(rows, (sort) => {
        assert.deepStrictEqual(sort, { createdAt: -1, _id: -1 });
      });
    };

    const req = {
      query: { limit: "2" },
      user: { uid: "verified-uid" },
    };
    const res = createResponse();

    await getStudentFeed(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(
      res.body.items.map((item) => item.name),
      ["Newest", "Second"],
    );
    assert.strictEqual(res.body.hasMore, true);
    assert.ok(res.body.nextCursor);
  } finally {
    Student.findOne = originals.studentFindOne;
    Event.find = originals.eventFind;
  }
});

test("getStudentFeed applies cursor conditions to fetch the next page", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    eventFind: Event.find,
  };

  try {
    Student.findOne = async () => studentRecord(HOME_UNIVERSITY_ID);
    const cursor = Buffer.from(
      JSON.stringify({
        createdAt: "2026-04-28T09:00:00.000Z",
        id: "64f000000000000000000012",
      }),
    ).toString("base64url");

    Event.find = (filter) => {
      assert.equal(filter.status, "PUBLISHED");
      assert.deepStrictEqual(filter.$or[0], { createdAt: { $lt: new Date("2026-04-28T09:00:00.000Z") } });
      assert.deepStrictEqual(filter.$or[1].createdAt, new Date("2026-04-28T09:00:00.000Z"));
      assert.equal(filter.$or[1]._id.$lt.toString(), "64f000000000000000000012");
      assert.equal(filter.$or[1]._id.$lt instanceof mongoose.Types.ObjectId, true);
      return queryChain([
        eventRecord("64f000000000000000000013", "Third", "2026-04-28T08:00:00.000Z", OUTSIDE_UNIVERSITY_ID),
      ]);
    };

    const req = {
      query: { limit: "2", cursor },
      user: { uid: "verified-uid" },
    };
    const res = createResponse();

    await getStudentFeed(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(
      res.body.items.map((item) => item.name),
      ["Third"],
    );
    assert.strictEqual(res.body.hasMore, false);
    assert.strictEqual(res.body.nextCursor, null);
  } finally {
    Student.findOne = originals.studentFindOne;
    Event.find = originals.eventFind;
  }
});

test("getStudentFeed filters university and outside events using student university", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    eventFind: Event.find,
  };

  try {
    Student.findOne = async () => studentRecord(HOME_UNIVERSITY_ID);

    Event.find = (filter) => {
      assert.strictEqual(filter.status, "PUBLISHED");
      assert.deepStrictEqual(filter.universityId, new mongoose.Types.ObjectId(HOME_UNIVERSITY_ID));
      assert.deepStrictEqual(filter.$nor, [{ closeAtActual: { $exists: true, $ne: null } }]);
      return queryChain([
        eventRecord("64f000000000000000000011", "Home", "2026-04-28T10:00:00.000Z", HOME_UNIVERSITY_ID),
      ]);
    };

    await getStudentFeed({ query: { filter: "UNIVERSITY" }, user: { uid: "verified-uid" } }, createResponse());

    Event.find = (filter) => {
      assert.strictEqual(filter.status, "PUBLISHED");
      assert.deepStrictEqual(filter.universityId, { $ne: new mongoose.Types.ObjectId(HOME_UNIVERSITY_ID) });
      assert.deepStrictEqual(filter.$nor, [{ closeAtActual: { $exists: true, $ne: null } }]);
      return queryChain([
        eventRecord("64f000000000000000000012", "Outside", "2026-04-28T09:00:00.000Z", OUTSIDE_UNIVERSITY_ID),
      ]);
    };

    await getStudentFeed({ query: { filter: "OUTSIDE" }, user: { uid: "verified-uid" } }, createResponse());
  } finally {
    Student.findOne = originals.studentFindOne;
    Event.find = originals.eventFind;
  }
});

test("getStudentFeed caps requested limit at 50", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    eventFind: Event.find,
  };

  try {
    Student.findOne = async () => studentRecord(HOME_UNIVERSITY_ID);

    Event.find = () => queryChain([], undefined, (limit) => {
      assert.strictEqual(limit, 51);
    });

    const res = createResponse();

    await getStudentFeed(
      {
        query: { limit: "500" },
        user: { uid: "verified-uid" },
      },
      res,
    );

    assert.strictEqual(res.statusCode, 200);
  } finally {
    Student.findOne = originals.studentFindOne;
    Event.find = originals.eventFind;
  }
});

test("getStudentFeed uses Atlas Search pipeline for case-insensitive fuzzy search", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    eventAggregate: Event.aggregate,
  };

  try {
    Student.findOne = async () => studentRecord(HOME_UNIVERSITY_ID);

    Event.aggregate = async (pipeline) => {
      const search = pipeline[0].$search;
      assert.strictEqual(search.index, "events_search");
      assert.deepStrictEqual(search.compound.must[0], {
        text: {
          query: "dabrang",
          path: ["name", "description", "venue", "type", "universityName", "skills"],
          fuzzy: {
            maxEdits: 2,
            prefixLength: 1,
          },
        },
      });
      assert.deepStrictEqual(search.compound.filter[0], {
        equals: { path: "status", value: "PUBLISHED" },
      });
      assert.deepStrictEqual(pipeline[1].$match.universityId, new mongoose.Types.ObjectId(HOME_UNIVERSITY_ID));
      assert.deepStrictEqual(pipeline[1].$match.$nor, [{ closeAtActual: { $exists: true, $ne: null } }]);
      assert.deepStrictEqual(pipeline[2], { $sort: { createdAt: -1, _id: -1 } });
      assert.deepStrictEqual(pipeline[3], { $limit: 21 });
      assert.strictEqual(pipeline.at(-1).$project.frozenScoreHistory, 0);
      assert.strictEqual(pipeline.at(-1).$project.scoringConfig, 0);

      return [
        eventRecord("64f000000000000000000011", "Sabrang", "2026-04-28T10:00:00.000Z", HOME_UNIVERSITY_ID),
      ];
    };

    const req = {
      query: { q: "dabrang", filter: "UNIVERSITY", limit: "20" },
      user: { uid: "verified-uid" },
    };
    const res = createResponse();

    await getStudentFeed(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.items[0].name, "Sabrang");
  } finally {
    Student.findOne = originals.studentFindOne;
    Event.aggregate = originals.eventAggregate;
  }
});

test("getStudentFeed searches by text when the search index is unavailable", async () => {
  const originals = { studentFindOne: Student.findOne, eventAggregate: Event.aggregate, eventFind: Event.find };
  try {
    Student.findOne = async () => studentRecord(HOME_UNIVERSITY_ID);
    Event.aggregate = async () => {
      throw new Error("index not found");
    };
    let filter = null;
    Event.find = (query, projection) => {
      filter = query;
      assert.strictEqual(projection.frozenScoreHistory, 0);
      return queryChain([
        eventRecord("64f000000000000000000011", "Sabrang", "2026-04-28T10:00:00.000Z", HOME_UNIVERSITY_ID),
      ]);
    };
    const response = createResponse();
    await getStudentFeed({ query: { q: "sabrang", limit: "20" }, user: { uid: "verified-uid" } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.items[0].name, "Sabrang");
    assert.equal(filter.status, "PUBLISHED");
    assert.equal(filter.$or.some((clause) => clause.name instanceof RegExp && clause.name.test("Sabrang")), true);
    assert.equal(filter.$or.some((clause) => clause.name instanceof RegExp && clause.name.test("other")), false);
  } finally {
    Student.findOne = originals.studentFindOne;
    Event.aggregate = originals.eventAggregate;
    Event.find = originals.eventFind;
  }
});

test("getStudentFeed rejects invalid cursors", async () => {
  const originals = {
    studentFindOne: Student.findOne,
  };

  try {
    Student.findOne = async () => studentRecord(HOME_UNIVERSITY_ID);

    const res = createResponse();

    await getStudentFeed(
      {
        query: { cursor: "not-valid" },
        user: { uid: "verified-uid" },
      },
      res,
    );

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.message, /Invalid cursor/);
  } finally {
    Student.findOne = originals.studentFindOne;
  }
});

test("publishEvent allows event-only publishing without feedback setup", async () => {
  const originals = {
    eventFindOne: Event.findOne,
    participantCountDocuments: Participant.countDocuments,
  };

  try {
    const draft = {
      _id: new mongoose.Types.ObjectId("64f000000000000000000031"),
      name: "Guest Lecture",
      status: "DRAFT",
      closeAtActual: null,
      openAt: null,
      closeAtTentative: null,
      skills: [],
      saveCalled: false,
      async save() {
        this.saveCalled = true;
      },
      toObject() {
        return {
          _id: this._id,
          name: this.name,
          status: this.status,
          openAt: this.openAt,
          closeAtTentative: this.closeAtTentative,
          skills: this.skills,
        };
      },
    };

    Event.findOne = async (filter) => {
      assert.deepStrictEqual(filter, {
        _id: "64f000000000000000000031",
        groupId: "authority-group",
      });
      return draft;
    };
    Participant.countDocuments = async (filter) => {
      assert.deepStrictEqual(filter, { eventId: draft._id });
      return 0;
    };

    const res = createResponse();

    await publishEvent(
      {
        params: { id: "64f000000000000000000031" },
        user: { groupId: "authority-group" },
      },
      res,
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.event.status, "PUBLISHED");
    assert.strictEqual(res.body.event.participantsCount, 0);
    assert.strictEqual(draft.saveCalled, true);
  } finally {
    Event.findOne = originals.eventFindOne;
    Participant.countDocuments = originals.participantCountDocuments;
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

function studentRecord(universityId) {
  return {
    universityId: {
      toString: () => universityId,
    },
  };
}

function eventRecord(id, name, createdAt, universityId) {
  return {
    _id: id,
    name,
    status: "PUBLISHED",
    createdAt: new Date(createdAt),
    universityId: {
      toString: () => universityId,
    },
    openAt: new Date("2026-01-01T00:00:00.000Z"),
    closeAtTentative: new Date("2026-12-31T00:00:00.000Z"),
    toObject() {
      return {
        _id: this._id,
        name: this.name,
        status: this.status,
        createdAt: this.createdAt,
        universityId: this.universityId,
        openAt: this.openAt,
        closeAtTentative: this.closeAtTentative,
      };
    },
  };
}

function authorityEventRecord(id, name, status) {
  return {
    _id: id,
    name,
    status,
    createdAt: new Date("2026-04-28T10:00:00.000Z"),
    openAt: status === "PUBLISHED" ? new Date("2026-01-01T00:00:00.000Z") : null,
    closeAtTentative: status === "PUBLISHED" ? new Date("2026-12-31T00:00:00.000Z") : null,
    toObject() {
      return {
        _id: this._id,
        name: this.name,
        status: this.status,
        createdAt: this.createdAt,
        openAt: this.openAt,
        closeAtTentative: this.closeAtTentative,
      };
    },
  };
}

test("deleteEvent removes participants and feedback only for the authority group event", async () => {
  const originals = {
    findOne: Event.findOne,
    participantDelete: Participant.deleteMany,
    feedbackDelete: FeedbackSubmission.deleteMany,
    eventDelete: Event.deleteOne,
  };
  const removed = [];
  try {
    Event.findOne = async (query) => {
      assert.deepStrictEqual(query, { _id: "event-1", groupId: "authority-group" });
      return { _id: "event-1" };
    };
    Participant.deleteMany = async (query) => {
      removed.push(["participants", query.eventId]);
    };
    FeedbackSubmission.deleteMany = async (query) => {
      removed.push(["feedback", query.eventId]);
    };
    Event.deleteOne = async (query) => {
      removed.push(["event", String(query._id)]);
    };
    const response = createResponse();
    await deleteEvent({ params: { id: "event-1" }, user: { groupId: "authority-group" } }, response);
    assert.equal(response.body.ok, true);
    assert.deepStrictEqual(removed, [
      ["participants", "event-1"],
      ["feedback", "event-1"],
      ["event", "event-1"],
    ]);
  } finally {
    Event.findOne = originals.findOne;
    Participant.deleteMany = originals.participantDelete;
    FeedbackSubmission.deleteMany = originals.feedbackDelete;
    Event.deleteOne = originals.eventDelete;
  }
});

test("updateEvent keeps a published event's feedback window editable", async () => {
  const originals = { findOne: Event.findOne };
  const event = {
    _id: "event-1",
    status: "PUBLISHED",
    closeAtActual: null,
    levels: [],
    committees: [],
    markModified() {},
    async save() {},
    toObject() {
      return { status: this.status, openAt: this.openAt, closeAtTentative: this.closeAtTentative };
    },
  };
  try {
    Event.findOne = async () => event;
    const response = createResponse();
    await updateEvent({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      body: {
        openAt: "2026-05-01T09:00:00.000Z",
        closeAtTentative: "2026-05-08T09:00:00.000Z",
        scoringConfig: { lateSubmissions: "allow" },
      },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(event.openAt.toISOString(), "2026-05-01T09:00:00.000Z");
    assert.equal(event.closeAtTentative.toISOString(), "2026-05-08T09:00:00.000Z");
    assert.equal(event.scoringConfig.lateSubmissions, "allow");
    event.name = "Launch Fest";
    event.levels = ["Head"];
    await updateEvent({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      body: { name: "Renamed", levels: ["Volunteer"], skills: ["Speaking"], scoringConfig: { lateSubmissions: "reject" } },
    }, response);
    assert.equal(event.name, "Launch Fest");
    assert.deepEqual(event.levels, ["Head"]);
    assert.equal(event.skills, undefined);
    assert.equal(event.scoringConfig.lateSubmissions, "reject");
  } finally {
    Event.findOne = originals.findOne;
  }
});

test("updateEvent keeps a yes or no scoring choice and rejects any other word", async () => {
  const originalFindOne = Event.findOne;
  let saved = false;
  const event = {
    status: "DRAFT",
    closeAtActual: null,
    scoringConfig: { allowSelfRatings: false },
    markModified() {},
    async save() { saved = true; },
    toObject() { return { status: this.status, scoringConfig: this.scoringConfig }; },
  };
  try {
    Event.findOne = async () => event;
    const rejected = createResponse();
    await updateEvent({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      body: { scoringConfig: { allowSelfRatings: "maybe", identifyRaters: 1 } },
    }, rejected);
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.body.message, /self-rating choice/);
    assert.match(rejected.body.message, /who-reviewed-whom choice/);
    assert.equal(saved, false);
    assert.equal(event.scoringConfig.allowSelfRatings, false);

    const accepted = createResponse();
    await updateEvent({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      body: { scoringConfig: { allowSelfRatings: "yes", showComments: "no" } },
    }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.equal(event.scoringConfig.allowSelfRatings, true);
    assert.equal(event.scoringConfig.showComments, false);
    assert.equal(saved, true);
  } finally {
    Event.findOne = originalFindOne;
  }
});

test("updateEvent rejects an event date that is not a real day", async () => {
  const originalFindOne = Event.findOne;
  let saved = false;
  const event = {
    status: "DRAFT",
    closeAtActual: null,
    eventEndDate: null,
    markModified() {},
    async save() { saved = true; },
    toObject() { return { status: this.status }; },
  };
  try {
    Event.findOne = async () => event;
    const response = createResponse();
    await updateEvent({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      body: { eventEndDate: "2026-02-31T18:00" },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.message, "Enter a valid date and time");
    assert.equal(saved, false);
    assert.equal(event.eventEndDate, null);
  } finally {
    Event.findOne = originalFindOne;
  }
});

test("organizer edits do not load frozen score history", async () => {
  const originalFindOne = Event.findOne;
  const projections = [];
  const req = { params: { id: "event-1" }, user: { groupId: "authority-group" }, body: { email: "ada@x.com" }, file: { buffer: Buffer.from("x"), originalname: "poster.png" } };
  try {
    Event.findOne = async (filter, projection) => {
      projections.push(projection);
      return null;
    };
    for (const handler of [updateEvent, publishEvent, uploadParticipantsCsv, removeParticipant, getParticipants, uploadEventPoster, uploadEventLogo]) {
      const response = createResponse();
      await handler(req, response);
      assert.equal(response.statusCode, 404);
    }
    assert.equal(projections.length, 7);
    for (const projection of projections) assert.equal(projection.frozenScoreHistory, 0);
  } finally {
    Event.findOne = originalFindOne;
  }
});

test("updateEvent does not store a blank scoring field as zero", async () => {
  const originalFindOne = Event.findOne;
  let saved = false;
  const event = {
    status: "DRAFT",
    closeAtActual: null,
    scoringConfig: { levelInfluence: 0.15, skillWeights: { Planning: 1 } },
    markModified() {},
    async save() { saved = true; },
    toObject() { return { status: this.status, scoringConfig: this.scoringConfig }; },
  };
  try {
    Event.findOne = async () => event;
    const response = createResponse();
    await updateEvent({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      body: { scoringConfig: { levelInfluence: " ", skillWeights: { Planning: " " }, minimumRatings: " " } },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /level influence/);
    assert.match(response.body.message, /skill weight for Planning/);
    assert.match(response.body.message, /minimum review count/);
    assert.equal(saved, false);
    assert.equal(event.scoringConfig.levelInfluence, 0.15);
    assert.equal(event.scoringConfig.skillWeights.Planning, 1);
  } finally {
    Event.findOne = originalFindOne;
  }
});

test("updateEvent rejects a scoring value that is not a number", async () => {
  const originalFindOne = Event.findOne;
  let saved = false;
  const event = {
    status: "DRAFT",
    closeAtActual: null,
    scoringConfig: { levelInfluence: 0.15 },
    markModified() {},
    async save() { saved = true; },
    toObject() { return { status: this.status, scoringConfig: this.scoringConfig }; },
  };
  try {
    Event.findOne = async () => event;
    const response = createResponse();
    await updateEvent({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      body: { scoringConfig: { levelInfluence: "high", scaleMin: 1 } },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /level influence/);
    assert.equal(saved, false);
    assert.equal(event.scoringConfig.levelInfluence, 0.15);
  } finally {
    Event.findOne = originalFindOne;
  }
});

test("updateEvent rejects a committee weight below zero and keeps a negative level influence", async () => {
  const originalFindOne = Event.findOne;
  let saved = false;
  const event = {
    status: "DRAFT",
    closeAtActual: null,
    scoringConfig: { committeeWeightSame: 1 },
    markModified() {},
    async save() { saved = true; },
    toObject() { return { status: this.status, scoringConfig: this.scoringConfig }; },
  };
  try {
    Event.findOne = async () => event;
    const rejected = createResponse();
    await updateEvent({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      body: { scoringConfig: { committeeWeightSame: -1, credibilityEpsilon: 0, skillWeights: { Planning: -2 } } },
    }, rejected);
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.body.message, /same-committee weight of zero or higher/);
    assert.match(rejected.body.message, /credibility constant above zero/);
    assert.match(rejected.body.message, /skill weight for Planning of zero or higher/);
    assert.equal(saved, false);
    assert.equal(event.scoringConfig.committeeWeightSame, 1);

    const accepted = createResponse();
    await updateEvent({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      body: { scoringConfig: { levelInfluence: -0.2, committeeWeightSame: 0 } },
    }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.equal(event.scoringConfig.levelInfluence, -0.2);
    assert.equal(event.scoringConfig.committeeWeightSame, 0);
    assert.equal(saved, true);
  } finally {
    Event.findOne = originalFindOne;
  }
});

test("getEventById shows a saved rank under the event's own spelling", async () => {
  const originalFindOne = Event.findOne;
  const originalAggregate = Event.aggregate;
  try {
    Event.aggregate = async () => [{ frozenAt: [] }];
    Event.findOne = async (filter, projection) => {
      assert.equal(projection.frozenScoreHistory, 0);
      return {
      status: "PUBLISHED",
      closeAtActual: null,
      levels: ["Head", " head "],
      committees: [{ name: "Ops", allowedLevels: ["head"] }],
      skills: ["Planning", "planning"],
      scoringConfig: {
        levelRanks: { " head ": 4 },
        skillWeights: { planning: 2 },
        relevance: { ops: { planning: 1 } },
      },
      toObject() {
        return {
          status: this.status,
          levels: this.levels,
          committees: this.committees,
          skills: this.skills,
          scoringConfig: this.scoringConfig,
        };
      },
    };
    };
    const response = createResponse();
    await getEventById({ params: { id: "event-1" }, user: { groupId: "authority-group" } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.event.levels, ["Head"]);
    assert.deepEqual(response.body.event.skills, ["Planning"]);
    assert.deepEqual(response.body.event.scoringConfig.levelRanks, { Head: 4 });
    assert.deepEqual(response.body.event.scoringConfig.skillWeights, { Planning: 2 });
    assert.deepEqual(response.body.event.scoringConfig.relevance, { Ops: { Planning: 1 } });
    assert.deepEqual(response.body.event.frozenScoreHistory, []);
  } finally {
    Event.findOne = originalFindOne;
    Event.aggregate = originalAggregate;
  }
});

test("getEventById returns freeze times without the stored score snapshots", async () => {
  const originals = { findOne: Event.findOne, aggregate: Event.aggregate };
  try {
    Event.findOne = async () => ({
      _id: "event-1",
      status: "CLOSED",
      toObject() { return { status: "CLOSED", name: "Launch Fest" }; },
    });
    Event.aggregate = async (pipeline) => {
      assert.equal(pipeline[1].$project.frozenAt, "$frozenScoreHistory.frozenAt");
      return [{ frozenAt: ["2026-03-01T00:00:00.000Z", null] }];
    };
    const response = createResponse();
    await getEventById({ params: { id: "event-1" }, user: { groupId: "authority-group" } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.event.frozenScoreHistory, [
      { frozenAt: "2026-03-01T00:00:00.000Z" },
      { frozenAt: null },
    ]);
    assert.equal(JSON.stringify(response.body).includes("participants"), false);
  } finally {
    Event.findOne = originals.findOne;
    Event.aggregate = originals.aggregate;
  }
});

test("updateEvent stores one spelling for a repeated level and committee", async () => {
  const originals = { findOne: Event.findOne };
  const event = {
    _id: "event-1",
    status: "DRAFT",
    closeAtActual: null,
    levels: [],
    committees: [],
    skills: [],
    markModified() {},
    async save() {},
    toObject() { return { status: this.status, levels: this.levels, committees: this.committees, skills: this.skills }; },
  };
  try {
    Event.findOne = async () => event;
    const response = createResponse();
    await updateEvent({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      body: {
        levels: ["Head", " head "],
        committees: [
          { name: "Ops", allowedLevels: ["head"] },
          { name: " ops ", allowedLevels: ["Head"] },
        ],
        skills: ["Planning", "planning"],
      },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(event.levels, ["Head"]);
    assert.deepEqual(event.committees, [{ name: "Ops", allowedLevels: ["Head"] }]);
    assert.deepEqual(event.skills, ["Planning"]);
    assert.deepEqual(response.body.event.levels, ["Head"]);
  } finally {
    Event.findOne = originals.findOne;
  }
});

test("removeParticipant drops the person and their reviews before the event is closed", async () => {
  const originals = {
    findOne: Event.findOne,
    deleteMany: Participant.deleteMany,
    feedbackDelete: FeedbackSubmission.deleteMany,
  };
  const removed = [];
  try {
    Event.findOne = async (query) => {
      assert.deepStrictEqual(query, { _id: "event-1", groupId: "authority-group" });
      return { _id: "event-1", status: "PUBLISHED" };
    };
    Participant.deleteMany = async (query) => {
      removed.push(query);
      return { deletedCount: 1 };
    };
    FeedbackSubmission.deleteMany = async (query) => {
      removed.push(query);
    };
    const response = createResponse();
    await removeParticipant({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      body: { email: " ada @Example.com " },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(removed[0].email.test(" ada @Example.com "), true);
    assert.equal(removed[1].$or[0].raterEmail.test("ada@example.com"), true);
    assert.equal(removed[1].$or[1].targetEmail.test("ada@example.com"), true);
    assert.equal(JSON.stringify(removed).includes("$expr"), false);
  } finally {
    Event.findOne = originals.findOne;
    Participant.deleteMany = originals.deleteMany;
    FeedbackSubmission.deleteMany = originals.feedbackDelete;
  }
});

test("uploadParticipantsCsv matches committee and level labels and updates an existing row", async () => {
  const originals = { findOne: Event.findOne, participantFind: Participant.find, bulkWrite: Participant.bulkWrite };
  let written;
  try {
    Event.findOne = async () => ({
      _id: "event-1",
      committees: [{ name: "Hospitality", allowedLevels: ["Head"] }],
      levels: ["Head", "Volunteer"],
    });
    Participant.find = () => ({ select: () => ({ lean: async () => [] }) });
    Participant.bulkWrite = async (ops) => {
      written = ops;
      return { upsertedCount: 0, modifiedCount: 1 };
    };
    const response = createResponse();
    await uploadParticipantsCsv({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      file: { buffer: Buffer.from("Name,Email,Committee Name,Level\nAda,ADA@x.com,  hospitality ,HEAD\n") },
    }, response);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.inserted, 0);
    assert.equal(response.body.updated, 1);
    assert.equal(response.body.total, 1);
    assert.equal(written[0].updateOne.update.$set.name, "Ada");
    assert.equal(written[0].updateOne.update.$set.committee, "Hospitality");
    assert.equal(written[0].updateOne.update.$set.level, "Head");
    assert.equal(written[0].updateOne.update.$set.email, "ada@x.com");
    assert.equal(written[0].updateOne.update.$setOnInsert.email, undefined);
    assert.equal(String(written[0].updateOne.update.$setOnInsert.eventId), "event-1");
  } finally {
    Event.findOne = originals.findOne;
    Participant.find = originals.participantFind;
    Participant.bulkWrite = originals.bulkWrite;
  }
});

test("uploadParticipantsCsv keeps committee and level written before the event lists them", async () => {
  const originals = { findOne: Event.findOne, participantFind: Participant.find, bulkWrite: Participant.bulkWrite };
  let written;
  try {
    Event.findOne = async () => ({ _id: "event-1", committees: [], levels: [] });
    Participant.find = () => ({ select: () => ({ lean: async () => [] }) });
    Participant.bulkWrite = async (ops) => {
      written = ops;
      return { upsertedCount: 1 };
    };
    const response = createResponse();
    await uploadParticipantsCsv({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      file: { buffer: Buffer.from("Name,Email,Committee,Level\nAda,ada@x.com,Hospitality,Head\n") },
    }, response);
    assert.equal(response.body.ok, true);
    assert.equal(written[0].updateOne.update.$set.committee, "Hospitality");
    assert.equal(written[0].updateOne.update.$set.level, "Head");
  } finally {
    Event.findOne = originals.findOne;
    Participant.find = originals.participantFind;
    Participant.bulkWrite = originals.bulkWrite;
  }
});

test("uploadParticipantsCsv keeps an existing name when the CSV name is blank", async () => {
  const originals = { findOne: Event.findOne, participantFind: Participant.find, bulkWrite: Participant.bulkWrite };
  let written;
  try {
    Event.findOne = async () => ({
      _id: "event-1",
      committees: [{ name: "Hospitality", allowedLevels: ["Head"] }],
      levels: ["Head"],
    });
    Participant.find = () => ({ select: () => ({ lean: async () => [] }) });
    Participant.bulkWrite = async (ops) => {
      written = ops;
      return { upsertedCount: 0 };
    };
    const response = createResponse();
    await uploadParticipantsCsv({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      file: { buffer: Buffer.from("Name,Email,Committee,Level\n,ada@x.com,Hospitality,Head\n") },
    }, response);
    assert.equal(response.body.ok, true);
    assert.equal(written[0].updateOne.update.$set.name, undefined);
    assert.equal(written[0].updateOne.update.$set.level, "Head");
  } finally {
    Event.findOne = originals.findOne;
    Participant.find = originals.participantFind;
    Participant.bulkWrite = originals.bulkWrite;
  }
});

test("uploadParticipantsCsv updates a row whose saved email differs only by case", async () => {
  const originals = { findOne: Event.findOne, participantFind: Participant.find, bulkWrite: Participant.bulkWrite };
  let written;
  try {
    Event.findOne = async () => ({
      _id: "event-1",
      committees: [{ name: "Hospitality", allowedLevels: ["Head"] }],
      levels: ["Head"],
    });
    Participant.find = () => ({
      select: () => ({ lean: async () => [{ _id: "row-1", email: "Ada@x.com" }] }),
    });
    Participant.bulkWrite = async (ops) => {
      written = ops;
      return { upsertedCount: 0, modifiedCount: 1 };
    };
    const response = createResponse();
    await uploadParticipantsCsv({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      file: { buffer: Buffer.from("Name,Email,Committee,Level\nAda,ada@x.com,Hospitality,Head\n") },
    }, response);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.inserted, 0);
    assert.equal(response.body.updated, 1);
    assert.equal(written[0].updateOne.filter._id, "row-1");
    assert.equal(written[0].updateOne.update.$set.email, "ada@x.com");
    assert.equal(written[0].updateOne.upsert, undefined);
  } finally {
    Event.findOne = originals.findOne;
    Participant.find = originals.participantFind;
    Participant.bulkWrite = originals.bulkWrite;
  }
});

test("uploadParticipantsCsv ignores hidden characters and spaces in an email cell", async () => {
  const originals = { findOne: Event.findOne, participantFind: Participant.find, bulkWrite: Participant.bulkWrite };
  let written;
  try {
    Event.findOne = async () => ({
      _id: "event-1",
      committees: [{ name: "Hospitality", allowedLevels: ["Head"] }],
      levels: ["Head"],
    });
    Participant.find = () => ({
      select: () => ({ lean: async () => [{ _id: "row-1", email: "ada@x.com" }] }),
    });
    Participant.bulkWrite = async (ops) => {
      written = ops;
      return { upsertedCount: 0, modifiedCount: 1 };
    };
    const response = createResponse();
    await uploadParticipantsCsv({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      file: { buffer: Buffer.from("Name,Email,Committee,Level\nAda,\uFEFFada @x.com\u00A0,Hospitality,Head\n") },
    }, response);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.updated, 1);
    assert.equal(written[0].updateOne.filter._id, "row-1");
    assert.equal(written[0].updateOne.update.$set.email, "ada@x.com");
    assert.equal(written[0].updateOne.upsert, undefined);
  } finally {
    Event.findOne = originals.findOne;
    Participant.find = originals.participantFind;
    Participant.bulkWrite = originals.bulkWrite;
  }
});

test("uploadParticipantsCsv accepts a level saved on a repeated committee spelling", async () => {
  const originals = { findOne: Event.findOne, participantFind: Participant.find, bulkWrite: Participant.bulkWrite };
  let written;
  try {
    Event.findOne = async () => ({
      _id: "event-1",
      status: "PUBLISHED",
      levels: ["Head", " head "],
      committees: [
        { name: "Ops", allowedLevels: ["Guest"] },
        { name: " ops ", allowedLevels: ["Head"] },
      ],
    });
    Participant.find = () => ({ select: () => ({ lean: async () => [] }) });
    Participant.bulkWrite = async (ops) => {
      written = ops;
      return { upsertedCount: 1, modifiedCount: 0 };
    };
    const response = createResponse();
    await uploadParticipantsCsv({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      file: { buffer: Buffer.from("Name,Email,Committee,Level\nAda,ada@x.com,ops,head\n") },
    }, response);
    assert.equal(response.body.ok, true);
    assert.equal(written[0].updateOne.update.$set.committee, "Ops");
    assert.equal(written[0].updateOne.update.$set.level, "Head");
  } finally {
    Event.findOne = originals.findOne;
    Participant.find = originals.participantFind;
    Participant.bulkWrite = originals.bulkWrite;
  }
});

test("uploadParticipantsCsv rejects a file after the event is closed", async () => {
  const original = Event.findOne;
  try {
    Event.findOne = async () => ({ _id: "event-1", status: "CLOSED", levels: ["Head"], committees: [] });
    const response = createResponse();
    await uploadParticipantsCsv({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      file: { buffer: Buffer.from("Email,Level\nada@x.com,Head\n") },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /closed/i);
  } finally {
    Event.findOne = original;
  }
});

test("uploadParticipantsCsv rejects a blank level when the event defines levels", async () => {
  const original = Event.findOne;
  try {
    Event.findOne = async () => ({
      _id: "event-1",
      committees: [{ name: "Hospitality", allowedLevels: ["Head"] }],
      levels: ["Head", "Volunteer"],
    });
    const response = createResponse();
    await uploadParticipantsCsv({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      file: { buffer: Buffer.from("Email,Committee,Level\nada@x.com,Hospitality,\n") },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.errors[0].field, "level");
    assert.match(response.body.errors[0].message, /required/i);
  } finally {
    Event.findOne = original;
  }
});

test("uploadParticipantsCsv rejects a level that is not mapped to the committee", async () => {
  const original = Event.findOne;
  try {
    Event.findOne = async () => ({
      _id: "event-1",
      committees: [{ name: "Hospitality", allowedLevels: ["Head"] }],
      levels: ["Head", "Volunteer"],
    });
    const response = createResponse();
    await uploadParticipantsCsv({
      params: { id: "event-1" },
      user: { groupId: "authority-group" },
      file: { buffer: Buffer.from("Email,Committee,Level\nada@x.com,Hospitality,Volunteer\n") },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.errors[0].field, "level");
  } finally {
    Event.findOne = original;
  }
});

test("closeEvent still freezes a published event after its end date", async () => {
  const originals = {
    findOne: Event.findOne,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
  };
  const event = {
    _id: "event-1",
    status: "PUBLISHED",
    eventStartDate: new Date("2020-01-01T00:00:00.000Z"),
    eventEndDate: new Date("2020-01-02T00:00:00.000Z"),
    closeAtActual: null,
    skills: ["Planning"],
    scoringConfig: null,
    markModified() {},
    async save() {},
    toObject() {
      return { status: this.status };
    },
  };
  try {
    Event.findOne = async () => event;
    Participant.find = () => ({ lean: async () => [] });
    FeedbackSubmission.find = () => ({ lean: async () => [] });
    const response = createResponse();
    await closeEvent({ params: { id: "event-1" }, user: { groupId: "authority-group" } }, response);
    assert.equal(response.body.ok, true);
    assert.equal(event.status, "CLOSED");
    assert.equal(event.frozenScores.configured, false);
    assert.ok(event.closeAtActual instanceof Date);
  } finally {
    Event.findOne = originals.findOne;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("closeEvent freezes the formula result instead of leaving the event unscored", async () => {
  const originals = {
    findOne: Event.findOne,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    studentFind: Student.find,
  };
  const event = {
    _id: "event-1",
    status: "PUBLISHED",
    eventStartDate: new Date("2026-01-01T00:00:00.000Z"),
    eventEndDate: new Date("2026-12-31T00:00:00.000Z"),
    closeAtActual: null,
    skills: ["Planning"],
    frozenScores: { formulaVersion: "epa-reindexed-v1", participants: [{ email: "target@example.com", eventScore: 4 }] },
    frozenScoreHistory: [],
    scoringConfig: {
      scaleMin: 1,
      scaleMax: 10,
      levelRanks: { Member: 1 },
      levelInfluence: 0,
      committeeWeightSame: 1,
      committeeWeightTop: 1,
      committeeWeightOther: 1,
      relevance: { Ops: { Planning: 1 } },
      credibilityEpsilon: 0.05,
      credibilityShrinkage: 5,
      confidencePrior: 5,
      skillWeights: { Planning: 1 },
      applyRelevanceToSkillWeights: false,
      contributesToScoring: true,
      evenMedianRule: "average",
      allowSelfRatings: false,
      blankSkillPolicy: "ignoreSkill",
      unscoredSkillPolicy: "exclude",
      crossEventRule: "equal",
    },
    markModified() {},
    async save() {},
    toObject() {
      return { status: this.status };
    },
  };
  try {
    Event.findOne = async () => event;
    Participant.find = () => ({
      lean: async () => [
        { email: "target@example.com", name: "Ada", level: "Member", committee: "Ops" },
        { email: "rater@example.com", level: "Member", committee: "Ops" },
      ],
    });
    FeedbackSubmission.find = () => ({
      lean: async () => [{
        raterEmail: "rater@example.com",
        targetEmail: "target@example.com",
        ratings: [{ skill: "Planning", score: 8, skipped: false }],
        submittedAt: new Date(),
      }],
    });
    Student.find = () => ({
      select: () => ({ lean: async () => [{ email: "Rater@example.com", name: "Rater" }] }),
    });
    const response = createResponse();
    await closeEvent({ params: { id: "event-1" }, user: { groupId: "authority-group" } }, response);
    const target = event.frozenScores.participants.find((person) => person.email === "target@example.com");
    assert.equal(response.body.ok, true);
    assert.equal(event.status, "CLOSED");
    assert.equal(event.frozenScores.formulaVersion, "epa-reindexed-v1");
    assert.equal(event.frozenScores.auditStatus, "final");
    assert.equal(target.eventScore, 8);
    assert.equal(target.name, "Ada");
    assert.equal(event.frozenScores.participants.find((person) => person.email === "rater@example.com").name, "Rater");
    assert.ok(target.confidence > 0);
    assert.equal(event.frozenScoreHistory.length, 1);
    assert.equal(event.frozenScoreHistory[0].participants[0].eventScore, 4);
  } finally {
    Event.findOne = originals.findOne;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Student.find = originals.studentFind;
  }
});

test("previewEventScores uses an account name when the roster name is blank", async () => {
  const originals = { findOne: Event.findOne, participantFind: Participant.find, feedbackFind: FeedbackSubmission.find, studentFind: Student.find };
  try {
    Event.findOne = () => ({
      lean: async () => ({
        _id: "event-1",
        status: "PUBLISHED",
        skills: ["Planning"],
        scoringConfig: {
          scaleMin: 1,
          scaleMax: 10,
          levelRanks: { Member: 1 },
          levelInfluence: 0,
          committeeWeightSame: 1,
          committeeWeightTop: 1,
          committeeWeightOther: 1,
          relevance: { Ops: { Planning: 1 } },
          credibilityEpsilon: 0.05,
          credibilityShrinkage: 5,
          confidencePrior: 5,
          skillWeights: { Planning: 1 },
          applyRelevanceToSkillWeights: false,
          contributesToScoring: true,
          evenMedianRule: "average",
          allowSelfRatings: false,
          blankSkillPolicy: "ignoreSkill",
          unscoredSkillPolicy: "exclude",
          crossEventRule: "equal",
        },
      }),
    });
    Participant.find = () => ({
      lean: async () => [
        { email: "Target@example.com", name: "", level: "Member", committee: "Ops" },
        { email: "rater@example.com", name: "Rater", level: "Member", committee: "Ops" },
      ],
    });
    FeedbackSubmission.find = () => ({
      lean: async () => [{
        raterEmail: "rater@example.com",
        targetEmail: "target@example.com",
        ratings: [{ skill: "Planning", score: 8, skipped: false }],
        submittedAt: new Date(),
      }],
    });
    let accountQuery;
    Student.find = (query) => {
      accountQuery = query;
      return { select: () => ({ lean: async () => [{ email: "  Tar get@example.com  ", name: "Ada Lovelace" }] }) };
    };
    const response = createResponse();
    await previewEventScores({ params: { id: "event-1" }, user: { groupId: "authority-group" } }, response);
    const target = response.body.scored.participants.find((person) => person.email === "target@example.com");
    assert.equal(target.name, "Ada Lovelace");
    assert.equal(target.eventScore, 8);
    assert.equal(accountQuery.email.test("  Tar get@example.com  "), true);
    assert.equal(accountQuery.email.test("other@example.com"), false);
    assert.equal(accountQuery.$expr, undefined);
  } finally {
    Event.findOne = originals.findOne;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Student.find = originals.studentFind;
  }
});

test("previewEventScores still returns scores when the account name lookup fails", async () => {
  const originals = { findOne: Event.findOne, participantFind: Participant.find, feedbackFind: FeedbackSubmission.find, studentFind: Student.find };
  try {
    Event.findOne = () => ({
      lean: async () => ({
        _id: "event-1",
        status: "PUBLISHED",
        skills: ["Planning"],
        scoringConfig: {
          scaleMin: 1,
          scaleMax: 10,
          levelRanks: { Member: 1 },
          levelInfluence: 0,
          committeeWeightSame: 1,
          committeeWeightTop: 1,
          committeeWeightOther: 1,
          relevance: { Ops: { Planning: 1 } },
          credibilityEpsilon: 0.05,
          credibilityShrinkage: 5,
          confidencePrior: 5,
          skillWeights: { Planning: 1 },
          applyRelevanceToSkillWeights: false,
          contributesToScoring: true,
          evenMedianRule: "average",
          allowSelfRatings: false,
          blankSkillPolicy: "ignoreSkill",
          unscoredSkillPolicy: "exclude",
          crossEventRule: "equal",
        },
      }),
    });
    Participant.find = () => ({
      lean: async () => [
        { email: "target@example.com", name: "", level: "Member", committee: "Ops" },
        { email: "rater@example.com", name: "Rater", level: "Member", committee: "Ops" },
      ],
    });
    FeedbackSubmission.find = () => ({
      lean: async () => [{
        raterEmail: "rater@example.com",
        targetEmail: "target@example.com",
        ratings: [{ skill: "Planning", score: 8, skipped: false }],
        submittedAt: new Date(),
      }],
    });
    Student.find = () => {
      throw new Error("db down");
    };
    const response = createResponse();
    await previewEventScores({ params: { id: "event-1" }, user: { groupId: "authority-group" } }, response);
    const target = response.body.scored.participants.find((person) => person.email === "target@example.com");
    assert.equal(response.statusCode, 200);
    assert.equal(target.eventScore, 8);
    assert.equal(target.name, undefined);
  } finally {
    Event.findOne = originals.findOne;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Student.find = originals.studentFind;
  }
});

test("getFeedbackSummary counts a review stored under a different skill capitalization", async () => {
  const originals = { eventFind: Event.find, participantFind: Participant.find, feedbackFind: FeedbackSubmission.find };
  try {
    Event.find = (filter, projection) => {
      assert.strictEqual(projection.frozenScoreHistory, 0);
      assert.deepStrictEqual(filter.status.$in, ["PUBLISHED", "CLOSED"]);
      return {
        sort: async () => [{
          _id: "event-1",
          status: "PUBLISHED",
          skills: ["Planning"],
          toObject() { return { name: "Launch Fest", skills: this.skills, status: this.status }; },
        }],
      };
    };
    Participant.find = () => ({
      lean: async () => [
        { email: "ada@x.com", name: "Ada" },
        { email: "bea@x.com", name: "Bea" },
      ],
    });
    FeedbackSubmission.find = () => ({
      select: () => ({
        lean: async () => [{
          raterEmail: "ada@x.com",
          targetEmail: "bea@x.com",
          ratings: [{ skill: "planning", score: 4, skipped: false }],
        }],
      }),
    });
    const response = createResponse();
    await getFeedbackSummary({ user: { groupId: "authority-group" } }, response);
    const ada = response.body.summaries[0].participants.find((person) => person.email === "ada@x.com");
    assert.equal(ada.submittedCount, 1);
    assert.equal(ada.isComplete, true);
  } finally {
    Event.find = originals.eventFind;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("getFeedbackSummary does not count a skipped skill as a completed review", async () => {
  const originals = { eventFind: Event.find, participantFind: Participant.find, feedbackFind: FeedbackSubmission.find };
  try {
    Event.find = () => ({
      sort: async () => [{
        _id: "event-1",
        status: "PUBLISHED",
        skills: ["Planning"],
        eventStartDate: new Date("2026-04-02T00:00:00.000Z"),
        toObject() {
          return {
            name: "Launch Fest",
            skills: this.skills,
            status: this.status,
            eventStartDate: this.eventStartDate,
            scoringConfig: { scaleMin: 1 },
            frozenScores: { participants: [{ email: "hidden@x.com", eventScore: 9 }] },
          };
        },
      }],
    });
    Participant.find = () => ({
      lean: async () => [
        { email: "ada@x.com", name: "Ada", rollNumber: "12", level: "Head", committee: "Ops" },
        { email: "bea@x.com", name: "Bea", level: "Head", committee: "Ops" },
      ],
    });
    FeedbackSubmission.find = () => ({
      select: () => ({
        lean: async () => [{
          raterEmail: "ada@x.com",
          targetEmail: "bea@x.com",
          ratings: [{ skill: "Planning", score: null, skipped: true }],
          submittedAt: new Date(),
        }],
      }),
    });
    const response = createResponse();
    await getFeedbackSummary({ user: { groupId: "authority-group" } }, response);
    const ada = response.body.summaries[0].participants.find((person) => person.email === "ada@x.com");
    assert.equal(response.body.ok, true);
    assert.equal(ada.rollNumber, "12");
    assert.equal(ada.submittedCount, 0);
    assert.equal(ada.isComplete, false);
    assert.equal(ada.started, true);
    assert.equal(ada.completionPct, 0);
    assert.equal(response.body.summaries[0].fullySubmittedCount, 0);
    assert.equal(response.body.summaries[0].partialCount, 1);
    assert.equal(response.body.summaries[0].notStartedCount, 1);
    assert.equal(response.body.summaries[0].event.scoringConfig, undefined);
    assert.equal(response.body.summaries[0].event.frozenScores, undefined);
    assert.equal(JSON.stringify(response.body).includes("hidden@x.com"), false);
    assert.equal(new Date(response.body.summaries[0].event.eventDate).toISOString(), "2026-04-02T00:00:00.000Z");
  } finally {
    Event.find = originals.eventFind;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("getFeedbackSummary does not count a blank score as a completed review", async () => {
  const originals = { eventFind: Event.find, participantFind: Participant.find, feedbackFind: FeedbackSubmission.find };
  try {
    Event.find = () => ({
      sort: async () => [{
        _id: "event-1",
        status: "PUBLISHED",
        skills: ["Planning"],
        toObject() { return { name: "Launch Fest", status: this.status, skills: this.skills }; },
      }],
    });
    Participant.find = () => ({
      lean: async () => [
        { email: "ada@x.com", name: "Ada", level: "Head", committee: "Ops" },
        { email: "bea@x.com", name: "Bea", level: "Head", committee: "Ops" },
      ],
    });
    FeedbackSubmission.find = () => ({
      select: () => ({
        lean: async () => [{
          raterEmail: "ada@x.com",
          targetEmail: "bea@x.com",
          ratings: [{ skill: "Planning", score: "  ", skipped: false }],
        }],
      }),
    });
    const response = createResponse();
    await getFeedbackSummary({ user: { groupId: "authority-group" } }, response);
    const ada = response.body.summaries[0].participants.find((person) => person.email === "ada@x.com");
    assert.equal(ada.submittedCount, 0);
    assert.equal(ada.isComplete, false);
    assert.equal(ada.started, true);
    assert.equal(response.body.summaries[0].partialCount, 1);
    assert.equal(response.body.summaries[0].notStartedCount, 1);
  } finally {
    Event.find = originals.eventFind;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("getFeedbackSummary does not require reviews when the event has no skills", async () => {
  const originals = {
    eventFind: Event.find,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    studentFind: Student.find,
  };
  try {
    Event.find = () => ({
      sort: async () => [{
        _id: "event-1",
        status: "PUBLISHED",
        skills: [" ", ""],
        toObject() { return { name: "Launch Fest", skills: this.skills, status: this.status }; },
      }],
    });
    Participant.find = () => ({
      lean: async () => [
        { email: "ada@x.com", name: "Ada" },
        { email: "bea@x.com", name: " " },
      ],
    });
    FeedbackSubmission.find = () => ({ select: () => ({ lean: async () => [] }) });
    let accountQuery = null;
    Student.find = (criteria) => {
      accountQuery = criteria;
      return { select: () => ({ lean: async () => [{ email: "Bea@X.com", name: "Bea" }] }) };
    };
    const response = createResponse();
    await getFeedbackSummary({ user: { groupId: "authority-group" } }, response);
    const summary = response.body.summaries[0];
    assert.equal(summary.participants.every((person) => person.requiredCount === 0 && person.isComplete && person.completionPct === 100), true);
    assert.equal(summary.fullySubmittedCount, 2);
    assert.equal(summary.notStartedCount, 0);
    assert.equal(summary.participants.find((person) => person.email === "bea@x.com").name, "Bea");
    assert.equal(accountQuery.email.test(" Bea@X.com "), true);
    assert.equal(accountQuery.email.test("ada@x.com"), false);
  } finally {
    Event.find = originals.eventFind;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Student.find = originals.studentFind;
  }
});

test("getFeedbackSummary does not count a self review when self ratings are off", async () => {
  const originals = { eventFind: Event.find, participantFind: Participant.find, feedbackFind: FeedbackSubmission.find };
  try {
    Event.find = () => ({
      sort: async () => [{
        _id: "event-1",
        status: "PUBLISHED",
        skills: ["Planning"],
        scoringConfig: { allowSelfRatings: false },
        toObject() { return { name: "Launch Fest", status: this.status }; },
      }],
    });
    Participant.find = () => ({
      lean: async () => [
        { email: "ada@x.com", name: "Ada" },
        { email: "bea@x.com", name: "Bea" },
      ],
    });
    FeedbackSubmission.find = () => ({
      select: () => ({
        lean: async () => [{
          raterEmail: "ada@x.com",
          targetEmail: "ada@x.com",
          ratings: [{ skill: "Planning", score: 8, skipped: false }],
        }],
      }),
    });
    const response = createResponse();
    await getFeedbackSummary({ user: { groupId: "authority-group" } }, response);
    const ada = response.body.summaries[0].participants.find((person) => person.email === "ada@x.com");
    assert.equal(ada.requiredCount, 1);
    assert.equal(ada.submittedCount, 0);
    assert.equal(ada.isComplete, false);
    assert.equal(ada.started, false);
    assert.equal(response.body.summaries[0].partialCount, 0);
    assert.equal(response.body.summaries[0].notStartedCount, 2);
  } finally {
    Event.find = originals.eventFind;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("getFeedbackSummary counts a self review when the organizer allows it", async () => {
  const originals = { eventFind: Event.find, participantFind: Participant.find, feedbackFind: FeedbackSubmission.find };
  try {
    Event.find = () => ({
      sort: async () => [{
        _id: "event-1",
        status: "PUBLISHED",
        skills: ["Planning", "Planning"],
        scoringConfig: { allowSelfRatings: true },
        toObject() { return { name: "Launch Fest", status: this.status }; },
      }],
    });
    Participant.find = () => ({
      lean: async () => [
        { email: "ada@x.com", name: "Ada" },
        { email: "bea@x.com", name: "Bea" },
      ],
    });
    FeedbackSubmission.find = () => ({ select: () => ({ lean: async () => [] }) });
    const response = createResponse();
    await getFeedbackSummary({ user: { groupId: "authority-group" } }, response);
    const ada = response.body.summaries[0].participants.find((person) => person.email === "ada@x.com");
    assert.equal(response.body.summaries[0].event.allowSelfRatings, true);
    assert.equal(ada.requiredCount, 2);
    assert.equal(ada.isComplete, false);
    assert.equal(response.body.summaries[0].notStartedCount, 2);
  } finally {
    Event.find = originals.eventFind;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("getFeedbackSummary hides who reviewed whom unless the organizer identifies raters", async () => {
  const originals = { eventFind: Event.find, participantFind: Participant.find, feedbackFind: FeedbackSubmission.find };
  const event = {
    _id: "event-1",
    status: "PUBLISHED",
    skills: ["Planning"],
    scoringConfig: {},
    toObject() { return { name: "Launch Fest", status: this.status }; },
  };
  try {
    Event.find = () => ({ sort: async () => [event] });
    Participant.find = () => ({
      lean: async () => [
        { email: "ada@x.com", name: "Ada" },
        { email: "bea@x.com", name: "Bea" },
      ],
    });
    FeedbackSubmission.find = () => ({
      select: () => ({
        lean: async () => [{
          raterEmail: "ada@x.com",
          targetEmail: "bea@x.com",
          ratings: [{ skill: "Planning", score: 8, skipped: false }],
        }],
      }),
    });
    const hidden = createResponse();
    await getFeedbackSummary({ user: { groupId: "authority-group" } }, hidden);
    const hiddenAda = hidden.body.summaries[0].participants.find((person) => person.email === "ada@x.com");
    assert.equal(hidden.body.summaries[0].event.identifyRaters, false);
    assert.equal(hiddenAda.submittedCount, 1);
    assert.deepEqual(hiddenAda.ratedTargets, []);

    event.scoringConfig = { identifyRaters: true };
    const shown = createResponse();
    await getFeedbackSummary({ user: { groupId: "authority-group" } }, shown);
    const shownAda = shown.body.summaries[0].participants.find((person) => person.email === "ada@x.com");
    assert.equal(shown.body.summaries[0].event.identifyRaters, true);
    assert.equal(shownAda.ratedTargets[0].email, "bea@x.com");
    assert.equal(shownAda.ratedTargets[0].name, "Bea");
  } finally {
    Event.find = originals.eventFind;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("getFeedbackSummary matches a review when the roster email differs only by case", async () => {
  const originals = { eventFind: Event.find, participantFind: Participant.find, feedbackFind: FeedbackSubmission.find };
  try {
    Event.find = () => ({
      sort: async () => [{
        _id: "event-1",
        status: "PUBLISHED",
        skills: ["Planning"],
        scoringConfig: { identifyRaters: true },
        toObject() { return { name: "Launch Fest", status: "PUBLISHED" }; },
      }],
    });
    Participant.find = () => ({
      lean: async () => [
        { email: "Ada@x.com", name: "Ada" },
        { email: "Bea@x.com", name: "Bea" },
      ],
    });
    FeedbackSubmission.find = () => ({
      select: () => ({
        lean: async () => [{
          raterEmail: "ada@x.com",
          targetEmail: "bea@x.com",
          ratings: [{ skill: "Planning", score: 8, skipped: false }],
        }],
      }),
    });
    const response = createResponse();
    await getFeedbackSummary({ user: { groupId: "authority-group" } }, response);
    const ada = response.body.summaries[0].participants.find((person) => person.email === "ada@x.com");
    assert.equal(ada.submittedCount, 1);
    assert.equal(ada.ratedTargets[0].name, "Bea");
    assert.equal(ada.ratedTargets[0].email, "bea@x.com");
  } finally {
    Event.find = originals.eventFind;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("getFeedbackSummary matches a review when the stored emails have extra spaces", async () => {
  const originals = {
    eventFind: Event.find,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    studentFind: Student.find,
  };
  try {
    Event.find = () => ({
      sort: async () => [{
        _id: "event-1",
        status: "PUBLISHED",
        skills: ["Planning"],
        scoringConfig: { identifyRaters: true },
        toObject() { return { name: "Launch Fest", status: "PUBLISHED" }; },
      }],
    });
    Participant.find = () => ({
      lean: async () => [
        { email: "ada@x.com", name: "Ada" },
        { email: "bea@x.com", name: "  " },
      ],
    });
    FeedbackSubmission.find = () => ({
      select: () => ({
        lean: async () => [{
          raterEmail: "  Ada@x.com  ",
          targetEmail: "  Bea@x.com  ",
          ratings: [{ skill: "Planning", score: 8, skipped: false }],
        }],
      }),
    });
    Student.find = () => ({
      select: () => ({ lean: async () => [{ email: "  Bea@x.com  ", name: "  Beatrice  " }] }),
    });
    const response = createResponse();
    await getFeedbackSummary({ user: { groupId: "authority-group" } }, response);
    const ada = response.body.summaries[0].participants.find((person) => person.email === "ada@x.com");
    assert.equal(ada.submittedCount, 1);
    assert.equal(ada.isComplete, true);
    assert.equal(ada.ratedTargets[0].name, "Beatrice");
    assert.equal(ada.ratedTargets[0].email, "bea@x.com");
  } finally {
    Event.find = originals.eventFind;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Student.find = originals.studentFind;
  }
});

test("getSuggestions uses only the authority's university", async () => {
  const originals = {
    authority: Authority.findOne,
    aggregate: Event.aggregate,
    university: University.findOne,
  };
  const matches = [];
  try {
    Authority.findOne = async () => ({ email: "org@uni.edu", universityId: "uni-home" });
    Event.aggregate = async (pipeline) => {
      matches.push(pipeline[0].$match);
      return [{ originalName: pipeline[0].$match ? "Head" : "" }];
    };
    University.findOne = () => ({ select: async () => ({ venues: ["Main Hall"] }) });
    const response = createResponse();
    await getSuggestions({ user: { email: "org@uni.edu", groupId: "authority-group" } }, response);
    assert.equal(response.body.ok, true);
    assert.equal(matches.length, 2);
    assert.equal(matches[0].universityId, "uni-home");
    assert.equal(matches[1].universityId, "uni-home");
    assert.deepStrictEqual(response.body.venues, ["Main Hall"]);
  } finally {
    Authority.findOne = originals.authority;
    Event.aggregate = originals.aggregate;
    University.findOne = originals.university;
  }
});

test("previewEventScores returns the frozen snapshot after close", async () => {
  const originals = { findOne: Event.findOne, participantFind: Participant.find };
  try {
    const event = {
      _id: "event-1",
      status: "CLOSED",
      closeAtActual: new Date(),
      frozenScores: {
        formulaVersion: "epa-reindexed-v1",
        configured: true,
        eligible: true,
        participants: [{ email: "a@b.com", eventScore: 4 }],
      },
    };
    Event.findOne = () => ({ lean: async () => event });
    Participant.find = () => ({ lean: async () => [{ email: "a@b.com", name: "Ada" }] });
    const response = createResponse();
    await previewEventScores({ params: { id: "event-1" }, user: { groupId: "authority-group" } }, response);
    assert.equal(response.body.scored.participants[0].eventScore, 4);
    assert.equal(response.body.scored.participants[0].name, "Ada");
    assert.equal(response.body.scored.auditStatus, "final");
    assert.equal(event.frozenScores.participants[0].name, undefined);
  } finally {
    Event.findOne = originals.findOne;
    Participant.find = originals.participantFind;
  }
});

test("recalculateEventScores keeps the previous snapshot in audit history", async () => {
  const originals = {
    findOne: Event.findOne,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
  };
  const previous = { formulaVersion: "epa-reindexed-v1", participants: [], frozenAt: "earlier" };
  const event = {
    _id: "event-1",
    skills: [],
    scoringConfig: null,
    frozenScores: previous,
    frozenScoreHistory: [],
    markModified() {},
    async save() {},
  };
  try {
    Event.findOne = async () => event;
    Participant.find = () => ({ lean: async () => [] });
    FeedbackSubmission.find = () => ({ lean: async () => [] });
    const response = createResponse();
    await recalculateEventScores({ params: { id: "event-1" }, user: { groupId: "authority-group" } }, response);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.history[0], previous);
    assert.notEqual(event.frozenScores, previous);
    assert.equal(event.frozenScores.configured, false);
  } finally {
    Event.findOne = originals.findOne;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("recalculateEventScores appends the previous snapshot without loading stored history", async () => {
  const originals = {
    findOne: Event.findOne,
    updateOne: Event.updateOne,
    aggregate: Event.aggregate,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
  };
  const previous = { formulaVersion: "epa-reindexed-v1", participants: [{ eventScore: 4 }], frozenAt: "earlier" };
  let update = null;
  try {
    Event.findOne = async (filter, projection) => {
      assert.equal(projection.frozenScoreHistory, 0);
      return {
        _id: "event-1",
        skills: [],
        scoringConfig: null,
        frozenScores: previous,
        markModified() {},
        async save() {},
      };
    };
    Event.updateOne = async (filter, change) => {
      update = { filter, change };
    };
    Event.aggregate = async () => [{ frozenAt: ["earlier", "2026-04-01T00:00:00.000Z"] }];
    Participant.find = () => ({ lean: async () => [] });
    FeedbackSubmission.find = () => ({ lean: async () => [] });
    const response = createResponse();
    await recalculateEventScores({ params: { id: "event-1" }, user: { groupId: "authority-group" } }, response);
    assert.equal(response.body.ok, true);
    assert.equal(update.change.$push.frozenScoreHistory, previous);
    assert.deepEqual(response.body.history, [
      { frozenAt: "earlier" },
      { frozenAt: "2026-04-01T00:00:00.000Z" },
    ]);
    assert.equal(JSON.stringify(response.body.history).includes("eventScore"), false);
  } finally {
    Event.findOne = originals.findOne;
    Event.updateOne = originals.updateOne;
    Event.aggregate = originals.aggregate;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

function queryChain(rows, onSort = () => {}, onLimit = () => {}) {
  return {
    sort(sort) {
      onSort(sort);
      return this;
    },
    limit: async (limit) => {
      onLimit(limit);
      return rows.slice(0, limit);
    },
  };
}
