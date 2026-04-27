const assert = require("assert");
const test = require("node:test");

process.env.DO_SPACES_ENDPOINT ||= "https://example.com";

const Event = require("../models/Event");
const Student = require("../models/Student");

const { getStudentFeed } = require("./events.controller");

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
