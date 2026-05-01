const assert = require("assert");
const test = require("node:test");

const { computeEffectiveStatus } = require("./eventStatus");

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
