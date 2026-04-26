const assert = require("assert");
const test = require("node:test");

const { mapEventForStudentFeed } = require("./eventFeed");

test("mapEventForStudentFeed labels events from the student's university", () => {
  const studentUniversityId = "64f000000000000000000001";
  const event = {
    status: "PUBLISHED",
    universityId: {
      toString: () => studentUniversityId,
    },
    openAt: new Date("2026-01-01T00:00:00.000Z"),
    closeAtTentative: new Date("2026-12-31T00:00:00.000Z"),
    toObject() {
      return {
        name: "Home event",
        universityId: this.universityId,
        status: this.status,
        openAt: this.openAt,
        closeAtTentative: this.closeAtTentative,
      };
    },
  };

  const mapped = mapEventForStudentFeed(event, studentUniversityId);

  assert.strictEqual(mapped.isUniversityEvent, true);
  assert.strictEqual(mapped.feedScope, "UNIVERSITY");
});

test("mapEventForStudentFeed labels events from other universities", () => {
  const event = {
    status: "PUBLISHED",
    universityId: {
      toString: () => "64f000000000000000000002",
    },
    openAt: new Date("2026-01-01T00:00:00.000Z"),
    closeAtTentative: new Date("2026-12-31T00:00:00.000Z"),
    toObject() {
      return {
        name: "Outside event",
        universityId: this.universityId,
        status: this.status,
        openAt: this.openAt,
        closeAtTentative: this.closeAtTentative,
      };
    },
  };

  const mapped = mapEventForStudentFeed(event, "64f000000000000000000001");

  assert.strictEqual(mapped.isUniversityEvent, false);
  assert.strictEqual(mapped.feedScope, "OUTSIDE");
});
