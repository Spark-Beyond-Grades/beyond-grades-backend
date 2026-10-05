const assert = require("assert");
const test = require("node:test");

const { computeEffectiveStatus, joinablePublishedFilter } = require("./eventStatus");

test("computeEffectiveStatus uses event dates instead of feedback dates", () => {
  const now = new Date("2026-05-01T10:00:00.000Z");

  const status = computeEffectiveStatus(
    {
      status: "PUBLISHED",
      eventStartDate: new Date("2026-05-10T10:00:00.000Z"),
      eventEndDate: new Date("2026-05-11T10:00:00.000Z"),
      openAt: new Date("2026-04-01T10:00:00.000Z"),
      closeAtTentative: new Date("2026-04-02T10:00:00.000Z"),
    },
    now
  );

  assert.strictEqual(status, "SCHEDULED");
});

test("computeEffectiveStatus closes a published event after its end date", () => {
  assert.strictEqual(
    computeEffectiveStatus(
      {
        status: "PUBLISHED",
        eventEndDate: new Date("2026-04-01T10:00:00.000Z"),
      },
      new Date("2026-05-01T10:00:00.000Z")
    ),
    "CLOSED"
  );
});

test("computeEffectiveStatus does not treat a start date as the end", () => {
  const now = new Date("2026-06-02T10:00:00.000Z");
  assert.strictEqual(
    computeEffectiveStatus(
      {
        status: "PUBLISHED",
        eventStartDate: new Date("2026-06-01T10:00:00.000Z"),
        eventDate: new Date("2026-06-01T10:00:00.000Z"),
        eventEndDate: null,
      },
      now
    ),
    "PUBLISHED"
  );
  assert.strictEqual(
    computeEffectiveStatus(
      {
        status: "PUBLISHED",
        eventDate: new Date("2026-04-01T10:00:00.000Z"),
      },
      now
    ),
    "CLOSED"
  );
});

test("joinablePublishedFilter keeps past-ended published events in the student feed", () => {
  const now = new Date("2026-05-01T10:00:00.000Z");
  const filter = joinablePublishedFilter(now);
  assert.strictEqual(filter.status, "PUBLISHED");
  assert.deepStrictEqual(filter.$nor, [
    { closeAtActual: { $exists: true, $ne: null } },
  ]);
});

test("computeEffectiveStatus keeps event-only published events as published when dates are absent", () => {
  assert.strictEqual(
    computeEffectiveStatus(
      {
        status: "PUBLISHED",
        eventStartDate: null,
        eventEndDate: null,
        eventDate: null,
        openAt: null,
        closeAtTentative: null,
      },
      new Date("2026-05-01T10:00:00.000Z")
    ),
    "PUBLISHED"
  );
});
