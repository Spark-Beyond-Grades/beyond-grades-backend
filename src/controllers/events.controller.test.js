const assert = require("assert");
const test = require("node:test");
const mongoose = require("mongoose");

process.env.DO_SPACES_ENDPOINT ||= "https://example.com";

const Event = require("../models/Event");
const Student = require("../models/Student");

const { getStudentFeed, listEvents } = require("./events.controller");

const HOME_UNIVERSITY_ID = "64f000000000000000000001";
const OUTSIDE_UNIVERSITY_ID = "64f000000000000000000002";

test("listEvents returns draft and published authority events for the group", async () => {
  const originalEventFind = Event.find;

  try {
    const rows = [
      authorityEventRecord("64f000000000000000000021", "Draft setup", "DRAFT"),
      authorityEventRecord("64f000000000000000000022", "Live event", "PUBLISHED"),
    ];

    Event.find = (filter) => {
      assert.deepStrictEqual(filter, { groupId: "authority-group" });
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
        ["Live event", "PUBLISHED", "OPEN"],
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

    Event.find = (filter) => {
      assert.deepStrictEqual(filter, { status: "PUBLISHED" });
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
      assert.deepStrictEqual(filter, { status: "PUBLISHED" });
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
      assert.deepStrictEqual(filter, {
        status: "PUBLISHED",
        $or: [
          { createdAt: { $lt: new Date("2026-04-28T09:00:00.000Z") } },
          {
            createdAt: new Date("2026-04-28T09:00:00.000Z"),
            _id: { $lt: "64f000000000000000000012" },
          },
        ],
      });
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
      assert.deepStrictEqual(filter, {
        status: "PUBLISHED",
        universityId: new mongoose.Types.ObjectId(HOME_UNIVERSITY_ID),
      });
      return queryChain([
        eventRecord("64f000000000000000000011", "Home", "2026-04-28T10:00:00.000Z", HOME_UNIVERSITY_ID),
      ]);
    };

    await getStudentFeed({ query: { filter: "UNIVERSITY" }, user: { uid: "verified-uid" } }, createResponse());

    Event.find = (filter) => {
      assert.deepStrictEqual(filter, {
        status: "PUBLISHED",
        universityId: { $ne: new mongoose.Types.ObjectId(HOME_UNIVERSITY_ID) },
      });
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
      assert.deepStrictEqual(pipeline[1], { $match: { universityId: new mongoose.Types.ObjectId(HOME_UNIVERSITY_ID) } });
      assert.deepStrictEqual(pipeline[2], { $sort: { createdAt: -1, _id: -1 } });
      assert.deepStrictEqual(pipeline[3], { $limit: 21 });

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
