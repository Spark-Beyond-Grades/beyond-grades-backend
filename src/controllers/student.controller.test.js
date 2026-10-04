const assert = require("assert");
const test = require("node:test");

const Event = require("../models/Event");
const FeedbackSubmission = require("../models/FeedbackSubmission");
const Participant = require("../models/Participant");
const Student = require("../models/Student");
const University = require("../models/University");

process.env.CLOUDINARY_URL ||= "cloudinary://key:secret@example";
process.env.DO_SPACES_CDN_BASE ||= "https://cdn.example.com";

const { getEventDetail, getEventTeam, syncStudent, updateProfile, getStudentDashboard, getPublicDashboardProfile, registerForEvent, submitEventFeedback, getLeaderboard, getDashboardPrivacy, skillHistoryFromEvents, compareLeaderboardRows, overallScaleBoards, rankedOverall } = require("./student.controller");

function queryResult(rows) {
  return {
    select() {
      return this;
    },
    lean: async () => rows,
  };
}

test("getStudentDashboard returns server-calculated event and overall scores without exposing raters", async () => {
  const originals = {
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };

  try {
    Participant.find = (query) => queryResult(
      query.email === "target@example.com"
        ? [{ eventId: "64f000000000000000000001", email: "target@example.com" }]
        : [
            { eventId: "64f000000000000000000001", email: "target@example.com", level: "Member", committee: "Ops" },
            { eventId: "64f000000000000000000001", email: "rater@example.com", level: "Member", committee: "Ops" },
          ]
    );
    Event.find = () => queryResult([
      {
        _id: { toString: () => "64f000000000000000000001" },
        name: "Launch Fest",
        skills: ["Planning"],
        status: "CLOSED",
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
          evenMedianRule: "average",
          allowSelfRatings: false,
          blankSkillPolicy: "ignoreSkill",
          unscoredSkillPolicy: "exclude",
          crossEventRule: "equal",
          contributesToScoring: true,
          showComments: true,
        },
      },
    ]);
    FeedbackSubmission.find = (query) => queryResult(
      query.$expr
        ? []
        : [{
            eventId: "64f000000000000000000001",
            raterEmail: "rater@example.com",
            targetEmail: "  Target@Example.com  ",
            ratings: [{ skill: "Planning", score: 8, skipped: false, comment: "Great" }],
            submittedAt: new Date(),
          }]
    );

    const response = captureResponse();
    await getStudentDashboard({ user: { email: "target@example.com" } }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.overall.score, 8);
    assert.equal(response.body.events[0].eventScore, 8);
    assert.equal(response.body.summary.eventsJoined, 1);
    assert.equal(response.body.summary.eventsCompleted, 1);
    assert.equal(response.body.events[0].frozenAt, null);
    assert.equal(response.body.events[0].status, "READY");
    assert.equal(response.body.events[0].auditStatus, "final");
    assert.equal(response.body.overall.auditStatus, "final");
    assert.equal(response.body.events[0].feedback[0].comment, "Great");
    assert.equal(response.body.events[0].feedback[0].raterEmail, undefined);
    assert.equal(response.body.pendingFeedback.length, 0);
    assert.equal(JSON.stringify(response.body).includes("rater@example.com"), false);
    assert.equal(response.body.events[0].skills[0].ratingCount, 1);
    assert.equal(response.body.events[0].reviewCount, 1);
    assert.equal(response.body.events[0].level, "Member");
    assert.equal(response.body.events[0].committee, "Ops");
    assert.equal(response.body.events[0].feedbackGivenCount, 0);
    assert.equal(response.body.events[0].feedbackExpectedCount, 1);
    assert.equal(response.body.events[0].feedbackComplete, false);
    assert.equal(response.body.summary.eventsJoined, 1);
    assert.equal(response.body.summary.feedbackGiven, 0);
    assert.equal(response.body.summary.feedbackReceived, 1);
    assert.equal(response.body.summary.pendingCount, 0);
    assert.equal(response.body.formulaVersion, "epa-reindexed-v1");
    assert.equal(response.body.skillHistory[0].skill, "Planning");
    assert.equal(response.body.skillHistory[0].direction, "single");
    assert.equal(response.body.skillHistory[0].points[0].score, 8);
    assert.equal(response.body.skillHistory[0].points[0].eventName, "Launch Fest");
  } finally {
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("skillHistoryFromEvents keeps each event score in date order without combining them", () => {
  const history = skillHistoryFromEvents([
    {
      eventId: "later",
      eventName: "Later Fest",
      eventDate: "2026-05-01",
      scaleMin: 1,
      scaleMax: 10,
      skills: [{ skill: "planning", score: 9, confidence: 0.4, ratingCount: 2 }],
    },
    {
      eventId: "earlier",
      eventName: "Earlier Fest",
      eventDate: "2026-01-01",
      scaleMin: 1,
      scaleMax: 10,
      skills: [{ skill: "Planning", score: 6, confidence: 0.2, ratingCount: 1 }],
    },
    {
      eventId: "empty",
      eventName: "Unscored Fest",
      eventDate: "2026-06-01",
      skills: [{ skill: "Planning", score: null, reason: "no_ratings" }],
    },
  ]);
  assert.equal(history.length, 1);
  assert.equal(history[0].skill, "planning");
  assert.deepEqual(history[0].points.map((point) => point.score), [6, 9]);
  assert.equal(history[0].direction, "up");
  assert.equal(history[0].score, undefined);

  const mixed = skillHistoryFromEvents([
    {
      eventId: "wide",
      eventName: "Wide Fest",
      eventDate: "2026-01-01",
      scaleMin: 1,
      scaleMax: 10,
      skills: [{ skill: "Planning", score: 8 }],
    },
    {
      eventId: "narrow",
      eventName: "Narrow Fest",
      eventDate: "2026-05-01",
      scaleMin: 1,
      scaleMax: 5,
      skills: [{ skill: "Planning", score: 4 }],
    },
  ]);
  assert.deepEqual(mixed[0].points.map((point) => point.score), [8, 4]);
  assert.equal(mixed[0].direction, "mixed_scales");

  const returned = skillHistoryFromEvents([
    { eventId: "a", eventName: "A", eventDate: "2026-01-01", scaleMin: 1, scaleMax: 10, skills: [{ skill: "Planning", score: 6 }] },
    { eventId: "b", eventName: "B", eventDate: "2026-03-01", scaleMin: 1, scaleMax: 10, skills: [{ skill: "Planning", score: 9 }] },
    { eventId: "c", eventName: "C", eventDate: "2026-05-01", scaleMin: 1, scaleMax: 10, skills: [{ skill: "Planning", score: 6 }] },
  ]);
  assert.equal(returned[0].direction, "varied");

  const steady = skillHistoryFromEvents([
    { eventId: "a", eventName: "A", eventDate: "2026-01-01", scaleMin: 1, scaleMax: 10, skills: [{ skill: "Planning", score: 6 }] },
    { eventId: "b", eventName: "B", eventDate: "2026-05-01", scaleMin: 1, scaleMax: 10, skills: [{ skill: "Planning", score: 6 }] },
  ]);
  assert.equal(steady[0].direction, "flat");
});

test("getStudentDashboard keeps a skipped skill as unfinished feedback", async () => {
  const originals = {
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  try {
    Participant.find = () => queryResult([
      { eventId: "64f000000000000000000001", email: "target@example.com", level: "Member", committee: "Ops" },
      { email: "rater@example.com", name: "Rater", level: "Member", committee: "Ops" },
    ]);
    Event.find = () => queryResult([{
      _id: { toString: () => "64f000000000000000000001" },
      name: "Launch Fest",
      skills: ["Planning"],
      status: "PUBLISHED",
      scoringConfig: { contributesToScoring: false },
    }]);
    FeedbackSubmission.find = (query) => queryResult(
      query.$expr
        ? [{
            eventId: "64f000000000000000000001",
            targetEmail: "rater@example.com",
            ratings: [{ skill: "Planning", score: null, skipped: true }],
            submittedAt: new Date(),
          }]
        : []
    );
    const response = captureResponse();
    await getStudentDashboard({ user: { email: "target@example.com" } }, response);
    assert.equal(response.body.events[0].feedbackComplete, false);
    assert.equal(response.body.events[0].feedbackGivenCount, 0);
    assert.equal(response.body.summary.eventsCompleted, 0);
    assert.equal(response.body.summary.feedbackGiven, 0);
    assert.equal(response.body.pendingFeedback.length, 1);
    assert.equal(response.body.pendingFeedback[0].targetName, "Rater");
  } finally {
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getStudentDashboard uses an account name when the roster name is blank", async () => {
  const originals = {
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
    studentFind: Student.find,
  };
  try {
    Participant.find = () => queryResult([
      { eventId: "64f000000000000000000001", email: "target@example.com", name: "Ada", level: "Member", committee: "Ops" },
      { email: "ra ter@example.com", name: "  ", level: "Member", committee: "Ops" },
    ]);
    Event.find = () => queryResult([{
      _id: { toString: () => "64f000000000000000000001" },
      name: "Launch Fest",
      skills: ["Planning"],
      status: "PUBLISHED",
    }]);
    FeedbackSubmission.find = () => queryResult([]);
    let accountQuery = null;
    Student.find = (criteria) => {
      accountQuery = criteria;
      return { select: () => ({ lean: async () => [{ email: "  Ra ter@example.com  ", name: "  Rater  " }] }) };
    };
    const response = captureResponse();
    await getStudentDashboard({ user: { email: "target@example.com" } }, response);
    assert.equal(response.body.pendingFeedback.length, 1);
    assert.equal(response.body.pendingFeedback[0].targetName, "Rater");
    assert.deepEqual(accountQuery.$expr.$in[1], ["rater@example.com"]);
    assert.equal(JSON.stringify(response.body).includes("rater@example.com"), false);
  } finally {
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
    Student.find = originals.studentFind;
  }
});

test("getStudentDashboard does not treat a self review as a teammate review", async () => {
  const originals = {
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  try {
    Participant.find = () => queryResult([
      { eventId: "64f000000000000000000001", email: "target@example.com", name: "Ada", level: "Member", committee: "Ops" },
      { email: "rater@example.com", name: "Rater", level: "Member", committee: "Ops" },
    ]);
    Event.find = () => queryResult([{
      _id: { toString: () => "64f000000000000000000001" },
      name: "Launch Fest",
      skills: ["Planning"],
      status: "PUBLISHED",
      scoringConfig: { allowSelfRatings: false },
    }]);
    FeedbackSubmission.find = () => queryResult([{
      eventId: "64f000000000000000000001",
      raterEmail: "target@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
      submittedAt: new Date(),
    }]);
    const response = captureResponse();
    await getStudentDashboard({ user: { email: "target@example.com" } }, response);
    assert.equal(response.body.events[0].feedbackComplete, false);
    assert.equal(response.body.events[0].feedbackGivenCount, 0);
    assert.equal(response.body.summary.feedbackGiven, 0);
    assert.equal(response.body.summary.feedbackReceived, 0);
    assert.equal(response.body.pendingFeedback.length, 1);
    assert.equal(response.body.pendingFeedback[0].targetName, "Rater");
  } finally {
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getStudentDashboard includes a self review when the organizer allows it", async () => {
  const originals = {
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  try {
    Participant.find = () => queryResult([
      { eventId: "64f000000000000000000001", email: "target@example.com", name: "Ada", level: "Member", committee: "Ops" },
      { email: "rater@example.com", name: "Rater", level: "Member", committee: "Ops" },
    ]);
    Event.find = () => queryResult([{
      _id: { toString: () => "64f000000000000000000001" },
      name: "Launch Fest",
      skills: ["Planning"],
      status: "PUBLISHED",
      scoringConfig: { allowSelfRatings: true },
    }]);
    FeedbackSubmission.find = () => queryResult([]);
    const response = captureResponse();
    await getStudentDashboard({ user: { email: "target@example.com" } }, response);
    assert.equal(response.body.events[0].feedbackExpectedCount, 2);
    assert.deepEqual(response.body.pendingFeedback.map((item) => item.targetName).sort(), ["Rater", "You"]);
  } finally {
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getStudentDashboard does not ask for feedback when the event has no skills", async () => {
  const originals = {
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  try {
    Participant.find = () => queryResult([
      { eventId: "64f000000000000000000001", email: "target@example.com", name: "Ada", level: "Member", committee: "Ops" },
      { email: "rater@example.com", name: "Rater", level: "Member", committee: "Ops" },
    ]);
    Event.find = () => queryResult([{
      _id: { toString: () => "64f000000000000000000001" },
      name: "Launch Fest",
      skills: [],
      status: "PUBLISHED",
    }]);
    FeedbackSubmission.find = () => queryResult([]);
    const response = captureResponse();
    await getStudentDashboard({ user: { email: "target@example.com" } }, response);
    assert.equal(response.body.pendingFeedback.length, 0);
    assert.equal(response.body.summary.pendingCount, 0);
    assert.equal(response.body.events[0].canReview, false);
    assert.equal(response.body.events[0].feedbackExpectedCount, 0);
    assert.equal(response.body.events[0].feedbackComplete, true);
  } finally {
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getStudentDashboard does not ask for feedback after the planned close unless late reviews are allowed", async () => {
  const originals = {
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  const event = {
    _id: { toString: () => "64f000000000000000000001" },
    name: "Launch Fest",
    skills: ["Planning"],
    status: "PUBLISHED",
    closeAtTentative: new Date(Date.now() - 60 * 60 * 1000),
  };
  try {
    Participant.find = () => queryResult([
      { eventId: "64f000000000000000000001", email: "target@example.com", name: "Ada", level: "Member", committee: "Ops" },
      { email: "rater@example.com", name: "Rater", level: "Member", committee: "Ops" },
    ]);
    FeedbackSubmission.find = () => queryResult([]);
    Event.find = () => queryResult([event]);
    const closed = captureResponse();
    await getStudentDashboard({ user: { email: "target@example.com" } }, closed);
    assert.equal(closed.body.pendingFeedback.length, 0);
    assert.equal(closed.body.events[0].canReview, false);
    assert.equal(closed.body.events[0].feedbackWindow, "late_unset");
    event.scoringConfig = { lateSubmissions: "reject" };
    const rejected = captureResponse();
    await getStudentDashboard({ user: { email: "target@example.com" } }, rejected);
    assert.equal(rejected.body.events[0].canReview, false);
    assert.equal(rejected.body.events[0].feedbackWindow, "closed");

    event.scoringConfig = { lateSubmissions: "allow" };
    const open = captureResponse();
    await getStudentDashboard({ user: { email: "target@example.com" } }, open);
    assert.equal(open.body.pendingFeedback.length, 1);
    assert.equal(open.body.events[0].canReview, true);
    assert.equal(open.body.events[0].feedbackWindow, "open");

    event.openAt = new Date(Date.now() + 60 * 60 * 1000);
    const scheduled = captureResponse();
    await getStudentDashboard({ user: { email: "target@example.com" } }, scheduled);
    assert.equal(scheduled.body.pendingFeedback.length, 0);
    assert.equal(scheduled.body.events[0].feedbackWindow, "scheduled");
  } finally {
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getStudentDashboard keeps a closed snapshot when later settings use a different rule", async () => {
  const originals = {
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  try {
    Participant.find = () => queryResult([
      { eventId: "64f000000000000000000001", email: "target@example.com", level: "Member", committee: "Ops" },
      { email: "rater@example.com", level: "Member", committee: "Ops" },
    ]);
    FeedbackSubmission.find = () => queryResult([{
      eventId: "64f000000000000000000001",
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
      submittedAt: new Date(),
    }]);
    Event.find = () => queryResult([{
      _id: { toString: () => "64f000000000000000000001" },
      name: "Launch Fest",
      skills: ["Planning"],
      status: "CLOSED",
      scoringConfig: { crossEventRule: "equal" },
      frozenScores: {
        configured: true,
        scaleMin: 1,
        scaleMax: 10,
        frozenAt: "2026-03-01T00:00:00.000Z",
        crossEventRule: "none",
        participants: [{
          email: "Target@Example.com",
          eventScore: 4,
          confidence: 0.5,
          status: "READY",
          scaleMin: 1,
          scaleMax: 10,
          skills: [{ skill: "Planning", score: 4, confidence: 0.5 }],
        }],
      },
    }]);
    const response = captureResponse();
    await getStudentDashboard({ user: { email: "target@example.com" } }, response);
    assert.equal(response.body.events[0].eventScore, 4);
    assert.equal(response.body.events[0].frozenAt, "2026-03-01T00:00:00.000Z");
    assert.equal(response.body.events[0].skills[0].score, 4);
    assert.equal(response.body.events[0].crossEventRule, "none");
    assert.equal(response.body.overall.reason, "cross_event_disabled");
    assert.equal(response.body.pendingFeedback.length, 0);
    assert.equal(response.body.summary.pendingCount, 0);
  } finally {
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getPublicDashboardProfile shares a published score only for the enabled sections", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  const scoringConfig = {
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
    evenMedianRule: "average",
    allowSelfRatings: false,
    blankSkillPolicy: "ignoreSkill",
    unscoredSkillPolicy: "exclude",
    crossEventRule: "equal",
    contributesToScoring: true,
    minimumRatings: 3,
  };
  try {
    Student.findOne = () => ({
      lean: async () => ({
        email: "  Target@Example.com  ",
        name: "Ada",
        dashboardPrivacy: { shareOverallScore: true, shareSkillScores: true, shareEventHistory: true, shareContributions: true },
      }),
    });
    Participant.find = () => queryResult([
      { eventId: "64f000000000000000000001", email: "target@example.com", level: "Member", committee: "Ops" },
      { email: "rater@example.com", level: "Member", committee: "Ops" },
    ]);
    Event.find = () => queryResult([{
      _id: { toString: () => "64f000000000000000000001" },
      name: "Launch Fest",
      skills: ["Planning"],
      status: "PUBLISHED",
      scoringConfig,
    }]);
    FeedbackSubmission.find = () => queryResult([{
      eventId: "64f000000000000000000001",
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false, comment: "Great" }],
      submittedAt: new Date(),
    }]);
    const response = captureResponse();
    await getPublicDashboardProfile({ params: { token: "shared-token" } }, response);
    const profile = response.body.profile;
    assert.equal(response.statusCode, 200);
    assert.equal(profile.formulaVersion, "epa-reindexed-v1");
    assert.equal(Number.isFinite(Date.parse(profile.calculatedAt)), true);
    assert.equal(profile.overall.score, 8);
    assert.equal(profile.overall.status, "PROVISIONAL");
    assert.equal(profile.overall.auditStatus, "provisional");
    assert.equal(profile.skills[0].eventId, "64f000000000000000000001");
    assert.equal(profile.skills[0].skill, "Planning");
    assert.equal(profile.skills[0].score, 8);
    assert.equal(profile.skillHistory[0].skill, "Planning");
    assert.equal(profile.skillHistory[0].points[0].score, 8);
    assert.equal(profile.events.length, 1);
    assert.equal(profile.events[0].eventScore, 8);
    assert.equal(profile.events[0].skills, undefined);
    assert.equal(profile.contributions[0].eventName, "Launch Fest");
    assert.equal(profile.contributions[0].reviewCount, 1);
    assert.equal(JSON.stringify(profile.contributions).includes("@"), false);
    assert.equal(JSON.stringify(profile).includes("rater@example.com"), false);
    assert.equal(JSON.stringify(profile).includes("Great"), false);
  } finally {
    Student.findOne = originals.studentFindOne;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getPublicDashboardProfile reports when a closed score was frozen", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  const frozenAt = "2026-03-01T00:00:00.000Z";
  try {
    Student.findOne = () => ({
      lean: async () => ({
        email: "target@example.com",
        name: "Ada",
        dashboardPrivacy: { shareOverallScore: true, shareSkillScores: true, shareEventHistory: true, shareContributions: false },
      }),
    });
    Participant.find = () => queryResult([
      { eventId: "64f000000000000000000001", email: "target@example.com", level: "Member", committee: "Ops" },
    ]);
    FeedbackSubmission.find = () => queryResult([]);
    Event.find = () => queryResult([{
      _id: { toString: () => "64f000000000000000000001" },
      name: "Launch Fest",
      skills: ["Planning"],
      status: "CLOSED",
      frozenScores: {
        formulaVersion: "epa-reindexed-v1",
        frozenAt,
        configured: true,
        eligible: true,
        scaleMin: 1,
        scaleMax: 10,
        crossEventRule: "equal",
        participants: [{
          email: "target@example.com",
          eventScore: 8,
          confidence: 0.5,
          status: "READY",
          scaleMin: 1,
          scaleMax: 10,
          skills: [{ skill: "Planning", score: 8, confidence: 0.5 }],
        }],
      },
    }]);
    const response = captureResponse();
    await getPublicDashboardProfile({ params: { token: "shared-token" } }, response);
    const profile = response.body.profile;
    assert.equal(profile.calculatedAt, frozenAt);
    assert.equal(profile.events[0].eventScore, 8);
    assert.equal(profile.shareOverallScore, undefined);
    assert.equal(JSON.stringify(profile).includes("shareSkillScores"), false);
    assert.equal(JSON.stringify(profile).includes("frozenAt"), false);
  } finally {
    Student.findOne = originals.studentFindOne;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getPublicDashboardProfile keeps a frozen calculation time when another joined event has no score", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  const frozenAt = "2026-03-01T00:00:00.000Z";
  try {
    Student.findOne = () => ({
      lean: async () => ({
        email: "target@example.com",
        name: "Ada",
        dashboardPrivacy: { shareOverallScore: true, shareSkillScores: true, shareEventHistory: true, shareContributions: false },
      }),
    });
    Participant.find = () => queryResult([
      { eventId: "64f000000000000000000001", email: "target@example.com", level: "Member", committee: "Ops" },
    ]);
    FeedbackSubmission.find = () => queryResult([]);
    Event.find = () => queryResult([
      {
        _id: { toString: () => "64f000000000000000000001" },
        name: "Launch Fest",
        skills: ["Planning"],
        status: "CLOSED",
        frozenScores: {
          formulaVersion: "epa-reindexed-v1",
          frozenAt,
          configured: true,
          eligible: true,
          scaleMin: 1,
          scaleMax: 10,
          crossEventRule: "equal",
          participants: [{
            email: "target@example.com",
            eventScore: 8,
            confidence: 0.5,
            status: "READY",
            scaleMin: 1,
            scaleMax: 10,
            skills: [{ skill: "Planning", score: 8, confidence: 0.5 }],
          }],
        },
      },
      {
        _id: { toString: () => "64f000000000000000000002" },
        name: "Open Fest",
        skills: ["Planning"],
        status: "PUBLISHED",
        scoringConfig: { contributesToScoring: false },
      },
    ]);
    const response = captureResponse();
    await getPublicDashboardProfile({ params: { token: "shared-token" } }, response);
    assert.equal(response.body.profile.calculatedAt, frozenAt);
    assert.equal(response.body.profile.events.length, 1);
  } finally {
    Student.findOne = originals.studentFindOne;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getPublicDashboardProfile keeps a skill score when the event has no EPA", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  const scoringConfig = {
    scaleMin: 1,
    scaleMax: 10,
    levelRanks: { Member: 1 },
    levelInfluence: 0,
    committeeWeightSame: 1,
    committeeWeightTop: 1,
    committeeWeightOther: 1,
    relevance: { Ops: { Planning: 1, Speaking: 1 } },
    credibilityEpsilon: 0.05,
    credibilityShrinkage: 5,
    confidencePrior: 5,
    skillWeights: { Planning: 1, Speaking: 1 },
    applyRelevanceToSkillWeights: false,
    evenMedianRule: "average",
    allowSelfRatings: false,
    blankSkillPolicy: "ignoreSkill",
    unscoredSkillPolicy: "block",
    crossEventRule: "equal",
    contributesToScoring: true,
  };
  try {
    Student.findOne = () => ({
      lean: async () => ({
        email: "target@example.com",
        name: "Ada",
        dashboardPrivacy: { shareOverallScore: true, shareSkillScores: true, shareEventHistory: true, shareContributions: false },
      }),
    });
    Participant.find = () => queryResult([
      { eventId: "64f000000000000000000001", email: "target@example.com", level: "Member", committee: "Ops" },
      { email: "rater@example.com", level: "Member", committee: "Ops" },
    ]);
    Event.find = () => queryResult([{
      _id: { toString: () => "64f000000000000000000001" },
      name: "Launch Fest",
      skills: ["Planning", "Speaking"],
      status: "PUBLISHED",
      scoringConfig,
    }]);
    FeedbackSubmission.find = () => queryResult([{
      eventId: "64f000000000000000000001",
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
      submittedAt: new Date(),
    }]);
    const response = captureResponse();
    await getPublicDashboardProfile({ params: { token: "shared-token" } }, response);
    const profile = response.body.profile;
    assert.equal(response.statusCode, 200);
    assert.equal(profile.events.length, 0);
    assert.equal(profile.skills.length, 1);
    assert.equal(profile.skills[0].skill, "Planning");
    assert.equal(profile.skills[0].score, 8);
    assert.equal(profile.skillHistory[0].points[0].score, 8);
    assert.equal(JSON.stringify(profile).includes("rater@example.com"), false);
  } finally {
    Student.findOne = originals.studentFindOne;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getPublicDashboardProfile hides the name and photo when those switches are off", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  try {
    Student.findOne = () => ({
      lean: async () => ({
        email: "target@example.com",
        name: "Ada",
        photoUrl: "https://cdn.example.com/ada.jpg",
        dashboardPrivacy: { showName: false, showPhoto: false, shareOverallScore: true },
      }),
    });
    Participant.find = () => queryResult([{ eventId: "event-1", email: "target@example.com", name: "Roster Ada", level: "Member", committee: "Ops" }]);
    Event.find = () => queryResult([{
      _id: { toString: () => "event-1" },
      name: "Launch Fest",
      status: "PUBLISHED",
      skills: [],
    }]);
    FeedbackSubmission.find = () => queryResult([]);
    const response = captureResponse();
    await getPublicDashboardProfile({ params: { token: "shared-token" } }, response);
    assert.equal(response.body.profile.name, null);
    assert.equal(response.body.profile.photoUrl, null);
    assert.equal(JSON.stringify(response.body.profile).includes("Roster Ada"), false);
    assert.equal(JSON.stringify(response.body.profile).includes("ada.jpg"), false);
  } finally {
    Student.findOne = originals.studentFindOne;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getPublicDashboardProfile does not count a self review when self ratings are off", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  try {
    Student.findOne = () => ({
      lean: async () => ({
        email: "target@example.com",
        name: "Ada",
        dashboardPrivacy: { shareContributions: true },
      }),
    });
    Participant.find = () => queryResult([]);
    Event.find = () => queryResult([{
      _id: { toString: () => "event-1" },
      name: "Launch Fest",
      skills: ["Planning"],
      status: "PUBLISHED",
      scoringConfig: { allowSelfRatings: false },
    }]);
    FeedbackSubmission.find = (query) => queryResult(
      query.$expr
        ? [{
            eventId: "event-1",
            targetEmail: "target@example.com",
            ratings: [{ skill: "Planning", score: 8, skipped: false }],
          }]
        : []
    );
    const response = captureResponse();
    await getPublicDashboardProfile({ params: { token: "shared-token" } }, response);
    assert.deepEqual(response.body.profile.contributions, []);
  } finally {
    Student.findOne = originals.studentFindOne;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getPublicDashboardProfile does not count a skipped review as a contribution", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  try {
    Student.findOne = () => ({
      lean: async () => ({
        email: "target@example.com",
        name: "Ada",
        dashboardPrivacy: { shareContributions: true },
      }),
    });
    Participant.find = () => queryResult([{ eventId: "event-1", email: "target@example.com", name: "Ada", level: "Member", committee: "Ops" }]);
    Event.find = () => queryResult([{
      _id: { toString: () => "event-1" },
      name: "Launch Fest",
      skills: ["Planning"],
      status: "PUBLISHED",
    }]);
    FeedbackSubmission.find = (query) => queryResult(
      query.$expr
        ? [{ eventId: "event-1", ratings: [{ skill: "Planning", score: null, skipped: true }] }]
        : []
    );
    const response = captureResponse();
    await getPublicDashboardProfile({ params: { token: "shared-token" } }, response);
    assert.deepEqual(response.body.profile.contributions, []);
  } finally {
    Student.findOne = originals.studentFindOne;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getPublicDashboardProfile uses a roster name when the account name is blank", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  try {
    Student.findOne = () => ({
      lean: async () => ({
        email: "target@example.com",
        name: " ",
        dashboardPrivacy: { showName: true, shareOverallScore: true },
      }),
    });
    Participant.find = () => queryResult([{ eventId: "event-1", email: "target@example.com", name: "Ada", level: "Member", committee: "Ops" }]);
    Event.find = () => queryResult([{
      _id: { toString: () => "event-1" },
      name: "Launch Fest",
      status: "PUBLISHED",
      skills: [],
    }]);
    FeedbackSubmission.find = () => queryResult([]);
    const response = captureResponse();
    await getPublicDashboardProfile({ params: { token: "shared-token" } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.profile.name, "Ada");
    assert.equal(JSON.stringify(response.body.profile).includes("@"), false);
  } finally {
    Student.findOne = originals.studentFindOne;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getPublicDashboardProfile keeps an unscored event in the overall rule check", async () => {
  const originals = {
    studentFindOne: Student.findOne,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    eventFind: Event.find,
  };
  const scoringConfig = {
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
    evenMedianRule: "average",
    allowSelfRatings: false,
    blankSkillPolicy: "ignoreSkill",
    unscoredSkillPolicy: "exclude",
    crossEventRule: "equal",
    contributesToScoring: true,
  };
  try {
    Student.findOne = () => ({
      lean: async () => ({
        email: "target@example.com",
        name: "Ada",
        dashboardPrivacy: { shareOverallScore: true, shareSkillScores: true, shareEventHistory: true, shareContributions: false },
      }),
    });
    Participant.find = () => queryResult([
      { eventId: "64f000000000000000000001", email: "target@example.com", level: "Member", committee: "Ops" },
      { email: "rater@example.com", level: "Member", committee: "Ops" },
    ]);
    Event.find = () => queryResult([
      {
        _id: { toString: () => "event-scored" },
        name: "Launch Fest",
        skills: ["Planning"],
        status: "PUBLISHED",
        scoringConfig,
      },
      {
        _id: { toString: () => "event-open" },
        name: "Open Fest",
        skills: ["Planning"],
        status: "PUBLISHED",
        scoringConfig: { ...scoringConfig, crossEventRule: "confidence" },
      },
    ]);
    FeedbackSubmission.find = (query) => queryResult(String(query.eventId) === "event-open" ? [] : [{
      eventId: "event-scored",
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
      submittedAt: new Date(),
    }]);
    const response = captureResponse();
    await getPublicDashboardProfile({ params: { token: "shared-token" } }, response);
    const profile = response.body.profile;
    assert.equal(profile.overall.score, null);
    assert.equal(profile.overall.reason, "mixed_cross_event_rules");
    assert.equal(profile.overall.auditStatus, "collecting");
    assert.equal(profile.events.length, 1);
    assert.equal(profile.events[0].eventName, "Launch Fest");
    assert.equal(profile.events[0].eventScore, 8);
    assert.equal(profile.skills[0].score, 8);
    assert.equal(JSON.stringify(profile.events).includes("Open Fest"), false);
  } finally {
    Student.findOne = originals.studentFindOne;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Event.find = originals.eventFind;
  }
});

test("getPublicDashboardProfile reports a server failure instead of a missing profile", async () => {
  const original = Student.findOne;
  try {
    Student.findOne = () => ({
      lean: async () => {
        throw new Error("db down");
      },
    });
    const response = captureResponse();
    await getPublicDashboardProfile({ params: { token: "shared-token" } }, response);
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.message, "Profile could not be loaded");
  } finally {
    Student.findOne = original;
  }
});

function captureResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
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

test("getEventTeam uses an account name when the roster name is blank", async () => {
  const originals = {
    eventFindById: Event.findById,
    participantFindOne: Participant.findOne,
    participantFind: Participant.find,
    studentAggregate: Student.aggregate,
    feedbackFind: FeedbackSubmission.find,
  };
  try {
    Event.findById = () => ({ lean: async () => ({ _id: { toString: () => "event-1" }, name: "Launch Fest", skills: ["Planning"] }) });
    Participant.findOne = () => ({ lean: async () => ({ email: "rater@example.com" }) });
    Participant.find = () => queryResult([{ name: " ", email: "asha@example.com", level: "Lead", committee: "Ops" }]);
    Student.aggregate = async () => [{ email: "asha@example.com", name: "Asha Rao" }];
    FeedbackSubmission.find = () => queryResult([]);
    const response = captureResponse();
    await getEventTeam({ params: { eventId: "event-1" }, user: { email: "rater@example.com" } }, response);
    assert.equal(response.body.items[0].name, "Asha Rao");
  } finally {
    Event.findById = originals.eventFindById;
    Participant.findOne = originals.participantFindOne;
    Participant.find = originals.participantFind;
    Student.aggregate = originals.studentAggregate;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("getEventTeam does not turn a missing rating minimum into zero", async () => {
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
        _id: { toString: () => "event-1" },
        name: "Launch Fest",
        skills: ["Planning"],
        scoringConfig: { scaleMin: null, scaleMax: 10 },
      }),
    });
    Participant.findOne = () => ({ lean: async () => ({ email: "rater@example.com" }) });
    Participant.find = () => queryResult([{ name: "Asha", email: "asha@example.com" }]);
    Student.aggregate = async () => [];
    FeedbackSubmission.find = () => queryResult([]);
    const response = captureResponse();
    await getEventTeam({ params: { eventId: "event-1" }, user: { email: "rater@example.com" } }, response);
    assert.equal(response.body.event.scaleMin, null);
    assert.equal(response.body.event.scaleMax, null);

    Event.findById = () => ({
      lean: async () => ({
        _id: { toString: () => "event-1" },
        name: "Launch Fest",
        skills: ["Planning"],
        scoringConfig: { scaleMin: 0, scaleMax: 5 },
      }),
    });
    const zeroMinimum = captureResponse();
    await getEventTeam({ params: { eventId: "event-1" }, user: { email: "rater@example.com" } }, zeroMinimum);
    assert.equal(zeroMinimum.body.event.scaleMin, 0);
    assert.equal(zeroMinimum.body.event.scaleMax, 5);
  } finally {
    Event.findById = originals.eventFindById;
    Participant.findOne = originals.participantFindOne;
    Participant.find = originals.participantFind;
    Student.aggregate = originals.studentAggregate;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("getEventTeam lists each skill once when the event repeats it", async () => {
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
        _id: { toString: () => "event-1" },
        name: "Launch Fest",
        skills: ["Planning", " Planning ", "planning", ""],
      }),
    });
    Participant.findOne = () => ({ lean: async () => ({ email: "rater@example.com" }) });
    Participant.find = () => queryResult([{ name: "Asha", email: "asha@example.com" }]);
    Student.aggregate = async () => [];
    FeedbackSubmission.find = () => queryResult([]);
    const response = captureResponse();
    await getEventTeam({ params: { eventId: "event-1" }, user: { email: "rater@example.com" } }, response);
    assert.deepEqual(response.body.event.skills, ["Planning"]);
    assert.deepEqual(response.body.items[0].pendingSkills, ["Planning"]);
  } finally {
    Event.findById = originals.eventFindById;
    Participant.findOne = originals.participantFindOne;
    Participant.find = originals.participantFind;
    Student.aggregate = originals.studentAggregate;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("getEventTeam includes the current rater when self ratings are allowed", async () => {
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
        _id: { toString: () => "event-1" },
        name: "Launch Fest",
        skills: ["Planning"],
        scoringConfig: { allowSelfRatings: true },
      }),
    });
    Participant.findOne = () => ({ lean: async () => ({ email: "rater@example.com" }) });
    Participant.find = () => queryResult([
      { name: "Current User", email: "rater@example.com", committee: "Ops", level: "Lead" },
      { name: "Asha Rao", email: "asha@example.com", committee: "Ops", level: "Lead" },
    ]);
    Student.aggregate = async () => [];
    FeedbackSubmission.find = () => queryResult([]);
    const response = captureResponse();
    await getEventTeam({ params: { eventId: "event-1" }, user: { email: "rater@example.com" } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.items.map((item) => item.email), ["rater@example.com", "asha@example.com"]);
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

test("getEventTeam keeps a whitespace score as unfinished feedback", async () => {
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
    Participant.findOne = () => ({ lean: async () => ({ email: "rater@example.com" }) });
    Participant.find = () => queryResult([
      { name: "Current User", email: "rater@example.com", committee: "Ops", level: "Lead" },
      { name: "Asha Rao", email: "asha@example.com", committee: "Ops", level: "Lead" },
    ]);
    Student.aggregate = async () => [];
    FeedbackSubmission.find = () => ({
      select: () => ({
        lean: async () => [{
          targetEmail: "asha@example.com",
          ratings: [{ skill: "Planning", score: "  ", skipped: false }],
        }],
      }),
    });
    const response = createResponse();
    await getEventTeam({
      params: { eventId: "64f000000000000000000001" },
      user: { email: "rater@example.com" },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.items[0].feedbackComplete, false);
    assert.deepEqual(response.body.items[0].pendingSkills, ["Planning"]);
  } finally {
    Event.findById = originals.eventFindById;
    Participant.findOne = originals.participantFindOne;
    Participant.find = originals.participantFind;
    Student.aggregate = originals.studentAggregate;
    FeedbackSubmission.find = originals.feedbackFind;
  }
});

test("getEventTeam finds a review stored with a lowercase email", async () => {
  const originals = {
    eventFindById: Event.findById,
    participantFindOne: Participant.findOne,
    participantFind: Participant.find,
    studentAggregate: Student.aggregate,
    feedbackFind: FeedbackSubmission.find,
  };
  const eventId = "64f000000000000000000001";
  try {
    let lookedUpEmail = null;
    Event.findById = () => ({ lean: async () => ({ _id: { toString: () => eventId }, name: "Launch Fest", skills: ["Planning"] }) });
    Participant.findOne = () => ({ lean: async () => ({ email: "rater@example.com" }) });
    Participant.find = () => queryResult([{ name: "Asha Rao", email: "asha@example.com", rollNumber: "", committee: "Ops", level: "Lead", position: "" }]);
    Student.aggregate = async () => [];
    FeedbackSubmission.find = (query) => {
      lookedUpEmail = query.$expr.$eq[1];
      return queryResult([{ targetEmail: "asha@example.com", ratings: [{ skill: "Planning", score: 4, skipped: false }] }]);
    };
    const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
    await getEventTeam({ params: { eventId }, user: { email: "Rater@Example.com" } }, res);
    assert.strictEqual(lookedUpEmail, "rater@example.com");
    assert.strictEqual(res.body.items[0].feedbackComplete, true);
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
        email: "Veri fied@Example.com",
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

test("getDashboardPrivacy reports an active share link without returning the address", async () => {
  const original = Student.findOne;
  try {
    Student.findOne = () => ({
      lean: async () => ({
        dashboardPrivacy: { shareOverallScore: true },
        shareTokenHash: "stored-hash",
        shareTokenRevokedAt: null,
      }),
    });
    const response = createResponse();
    await getDashboardPrivacy({ user: { uid: "verified-uid" } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.hasShareLink, true);
    assert.equal(response.body.settings.shareOverallScore, true);
    assert.equal(response.body.shareUrl, undefined);
    assert.equal(response.body.token, undefined);
  } finally {
    Student.findOne = original;
  }
});

test("getDashboardPrivacy reports no share link after it was revoked", async () => {
  const original = Student.findOne;
  try {
    Student.findOne = () => ({
      lean: async () => ({
        shareTokenHash: "stored-hash",
        shareTokenRevokedAt: new Date("2026-04-01T00:00:00.000Z"),
      }),
    });
    const response = createResponse();
    await getDashboardPrivacy({ user: { uid: "verified-uid" } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.hasShareLink, false);
  } finally {
    Student.findOne = original;
  }
});

test("updateProfile rejects a birthday that is not a real day", async () => {
  const response = createResponse();
  await updateProfile({
    user: { uid: "verified-uid", email: "verified@example.com" },
    body: {
      name: "Ada",
      photoUrl: "https://cdn.example.com/ada.jpg",
      universityId: "uni-1",
      dob: "2004-02-31",
      phone: "9876543210",
    },
  }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.message, "Invalid dob format");
});

test("updateProfile stores the signed-in email without spaces", async () => {
  const originals = { student: Student.findOneAndUpdate, university: University.findById };
  try {
    University.findById = async () => ({ _id: "uni-1", name: "North University" });
    Student.findOneAndUpdate = async (filter, update) => {
      assert.equal(filter.uid, "verified-uid");
      assert.equal(update.$set.email, "verified@example.com");
      return {
        _id: { toString: () => "student-id" },
        uid: "verified-uid",
        email: update.$set.email,
        name: update.$set.name,
        photoUrl: update.$set.photoUrl,
        provider: "google.com",
        universityId: { toString: () => "uni-1" },
        universityName: update.$set.universityName,
        dob: update.$set.dob,
        phone: update.$set.phone,
        bio: update.$set.bio,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastLoginAt: update.$set.lastLoginAt,
      };
    };
    const response = createResponse();
    await updateProfile({
      user: { uid: "verified-uid", email: "Veri fied@Example.com" },
      body: {
        name: "Ada",
        photoUrl: "https://cdn.example.com/ada.jpg",
        universityId: "uni-1",
        dob: "2004-04-01",
        phone: "9876543210",
        bio: "Hello",
      },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.email, "verified@example.com");
  } finally {
    Student.findOneAndUpdate = originals.student;
    University.findById = originals.university;
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
      eventStartDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      eventEndDate: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
      toObject() {
        return {
          _id: this._id,
          name: this.name,
          status: this.status,
          levels: ["Head"],
          eventStartDate: this.eventStartDate,
          eventEndDate: this.eventEndDate,
          scoringConfig: { scaleMin: 1, scaleMax: 10 },
          frozenScores: { participants: [{ email: "hidden@example.com", eventScore: 9 }] },
          frozenScoreHistory: [{ participants: [{ email: "hidden@example.com" }] }],
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
    assert.strictEqual(res.body.joined, false);
    assert.strictEqual(res.body.item.name, "Launch Fest");
    assert.strictEqual(res.body.item.effectiveStatus, "SCHEDULED");
    assert.deepStrictEqual(res.body.item.levels, ["Head"]);
    assert.equal(res.body.item.scoringConfig, undefined);
    assert.equal(res.body.item.frozenScores, undefined);
    assert.equal(res.body.item.frozenScoreHistory, undefined);
    assert.equal(JSON.stringify(res.body).includes("hidden@example.com"), false);
  } finally {
    Event.findById = originals.eventFindById;
    Participant.findOne = originals.participantFindOne;
  }
});

test("getEventDetail does not offer feedback after the event is closed", async () => {
  const originals = { eventFindById: Event.findById, participantFindOne: Participant.findOne };
  try {
    Event.findById = async () => ({
      status: "CLOSED",
      closeAtActual: new Date(),
      toObject() { return { name: "Launch Fest", status: "CLOSED" }; },
    });
    Participant.findOne = async () => ({ email: "student@example.com" });
    const response = createResponse();
    await getEventDetail({
      params: { eventId: "event-1" },
      user: { email: "student@example.com" },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.canGiveFeedback, false);
    assert.equal(response.body.joined, true);
  } finally {
    Event.findById = originals.eventFindById;
    Participant.findOne = originals.participantFindOne;
  }
});

test("getEventDetail does not offer feedback after the planned close", async () => {
  const originals = { eventFindById: Event.findById, participantFindOne: Participant.findOne };
  try {
    Event.findById = async () => ({
      status: "PUBLISHED",
      skills: ["Planning"],
      closeAtTentative: new Date(Date.now() - 60 * 60 * 1000),
      toObject() { return { name: "Launch Fest", status: "PUBLISHED", skills: ["Planning"] }; },
    });
    Participant.findOne = async () => ({ email: "student@example.com" });
    const response = createResponse();
    await getEventDetail({
      params: { eventId: "event-1" },
      user: { email: "student@example.com" },
    }, response);
    assert.equal(response.body.canGiveFeedback, false);
    assert.equal(response.body.joined, true);
    assert.equal(response.body.feedbackWindow, "late_unset");
  } finally {
    Event.findById = originals.eventFindById;
    Participant.findOne = originals.participantFindOne;
  }
});

test("submitEventFeedback rejects reviews after the event is closed", async () => {
  const originals = { findById: Event.findById, findOne: Participant.findOne };
  try {
    Event.findById = () => ({
      lean: async () => ({ _id: "event-1", status: "CLOSED", skills: ["Planning"], scoringConfig: { scaleMin: 1, scaleMax: 5 } }),
    });
    Participant.findOne = () => ({ lean: async () => ({ email: "person@example.com" }) });
    const response = captureResponse();
    await submitEventFeedback({
      params: { eventId: "event-1" },
      user: { email: "rater@example.com" },
      body: { targetEmail: "target@example.com", ratings: [{ skill: "Planning", score: 4, skipped: false }] },
    }, response);
    assert.equal(response.statusCode, 403);
    assert.match(response.body.message, /closed/i);
  } finally {
    Event.findById = originals.findById;
    Participant.findOne = originals.findOne;
  }
});

test("submitEventFeedback requires an explicit late policy after the planned close", async () => {
  const originals = { findById: Event.findById, findOne: Participant.findOne };
  try {
    Event.findById = () => ({
      lean: async () => ({
        _id: "event-1",
        status: "PUBLISHED",
        closeAtTentative: new Date("2020-01-01T00:00:00.000Z"),
        skills: ["Planning"],
        scoringConfig: { scaleMin: 1, scaleMax: 5 },
      }),
    });
    const response = captureResponse();
    await submitEventFeedback({
      params: { eventId: "event-1" },
      user: { email: "rater@example.com" },
      body: { targetEmail: "target@example.com", ratings: [{ skill: "Planning", score: 4, skipped: false }] },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /late submission policy/i);
  } finally {
    Event.findById = originals.findById;
    Participant.findOne = originals.findOne;
  }
});

test("submitEventFeedback keeps a rating that is only a rounding error past the scale", async () => {
  const originals = {
    findById: Event.findById,
    findOne: Participant.findOne,
    feedbackFindOne: FeedbackSubmission.findOne,
    create: FeedbackSubmission.create,
  };
  let saved;
  try {
    Event.findById = () => ({
      lean: async () => ({ _id: "event-1", skills: ["Planning"], scoringConfig: { scaleMin: 1, scaleMax: 5 } }),
    });
    Participant.findOne = () => ({ lean: async () => ({ email: "person@example.com" }) });
    FeedbackSubmission.findOne = async () => null;
    FeedbackSubmission.create = async (doc) => {
      saved = doc;
      return { _id: { toString: () => "sub-1" }, submittedAt: doc.submittedAt };
    };
    const response = captureResponse();
    await submitEventFeedback({
      params: { eventId: "event-1" },
      user: { email: "rater@example.com" },
      body: { targetEmail: "target@example.com", ratings: [{ skill: "Planning", score: 5.0000001, skipped: false }] },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(saved.ratings[0].score, 5);

    const tooHigh = captureResponse();
    await submitEventFeedback({
      params: { eventId: "event-1" },
      user: { email: "rater@example.com" },
      body: { targetEmail: "target@example.com", ratings: [{ skill: "Planning", score: 5.2, skipped: false }] },
    }, tooHigh);
    assert.equal(tooHigh.statusCode, 400);
  } finally {
    Event.findById = originals.findById;
    Participant.findOne = originals.findOne;
    FeedbackSubmission.findOne = originals.feedbackFindOne;
    FeedbackSubmission.create = originals.create;
  }
});

test("submitEventFeedback uses the organizer scale instead of 0 to 10", async () => {
  const originals = { findById: Event.findById, findOne: Participant.findOne };
  try {
    Event.findById = () => ({
      lean: async () => ({ _id: "event-1", skills: ["Planning"], scoringConfig: { scaleMin: 1, scaleMax: 5 } }),
    });
    Participant.findOne = () => ({ lean: async () => ({ email: "person@example.com" }) });
    const response = captureResponse();
    await submitEventFeedback({
      params: { eventId: "event-1" },
      user: { email: "rater@example.com" },
      body: { targetEmail: "target@example.com", ratings: [{ skill: "Planning", score: 8, skipped: false }] },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /1\.\.5/);
  } finally {
    Event.findById = originals.findById;
    Participant.findOne = originals.findOne;
  }
});

test("submitEventFeedback rejects a blank score instead of storing zero", async () => {
  const originals = { findById: Event.findById, findOne: Participant.findOne };
  try {
    Event.findById = () => ({
      lean: async () => ({ _id: "event-1", skills: ["Planning"], scoringConfig: { scaleMin: 0, scaleMax: 10 } }),
    });
    Participant.findOne = () => ({ lean: async () => ({ email: "person@example.com" }) });
    const response = captureResponse();
    await submitEventFeedback({
      params: { eventId: "event-1" },
      user: { email: "rater@example.com" },
      body: { targetEmail: "target@example.com", ratings: [{ skill: "Planning", score: "  ", skipped: false }] },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /Score is required for Planning/);
  } finally {
    Event.findById = originals.findById;
    Participant.findOne = originals.findOne;
  }
});

test("submitEventFeedback rejects a numeric score when the scale is inverted", async () => {
  const originals = { findById: Event.findById, findOne: Participant.findOne };
  try {
    Event.findById = () => ({
      lean: async () => ({ _id: "event-1", skills: ["Planning"], scoringConfig: { scaleMin: 10, scaleMax: 1 } }),
    });
    Participant.findOne = () => ({ lean: async () => ({ email: "person@example.com" }) });
    const response = captureResponse();
    await submitEventFeedback({
      params: { eventId: "event-1" },
      user: { email: "rater@example.com" },
      body: { targetEmail: "target@example.com", ratings: [{ skill: "Planning", score: 8, skipped: false }] },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /scale is not configured/i);
  } finally {
    Event.findById = originals.findById;
    Participant.findOne = originals.findOne;
  }
});

test("submitEventFeedback rejects a self rating unless the organizer allows it", async () => {
  const originals = { findById: Event.findById, findOne: Participant.findOne };
  try {
    Event.findById = () => ({
      lean: async () => ({ _id: "event-1", skills: ["Planning"], scoringConfig: { scaleMin: 1, scaleMax: 5, allowSelfRatings: false } }),
    });
    Participant.findOne = () => ({ lean: async () => ({ email: "rater@example.com" }) });
    const response = captureResponse();
    await submitEventFeedback({
      params: { eventId: "event-1" },
      user: { email: "Rater@example.com" },
      body: { targetEmail: "rater@example.com", ratings: [{ skill: "Planning", score: 4, skipped: false }] },
    }, response);
    assert.equal(response.statusCode, 403);
    assert.match(response.body.message, /self ratings are not allowed/i);
  } finally {
    Event.findById = originals.findById;
    Participant.findOne = originals.findOne;
  }
});

test("submitEventFeedback rejects the same skill twice in one review", async () => {
  const originals = { findById: Event.findById, findOne: Participant.findOne };
  try {
    Event.findById = () => ({
      lean: async () => ({ _id: "event-1", skills: ["Planning"], scoringConfig: { scaleMin: 1, scaleMax: 5 } }),
    });
    Participant.findOne = () => ({ lean: async () => ({ email: "person@example.com" }) });
    const response = captureResponse();
    await submitEventFeedback({
      params: { eventId: "event-1" },
      user: { email: "rater@example.com" },
      body: {
        targetEmail: "target@example.com",
        ratings: [
          { skill: "Planning", score: 4, skipped: false },
          { skill: "Planning", score: 2, skipped: false },
        ],
      },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /only once/i);
  } finally {
    Event.findById = originals.findById;
    Participant.findOne = originals.findOne;
  }
});

test("submitEventFeedback accepts one rating when the event lists that skill twice", async () => {
  const originals = {
    findById: Event.findById,
    findOne: Participant.findOne,
    feedbackFindOne: FeedbackSubmission.findOne,
    create: FeedbackSubmission.create,
  };
  let saved;
  try {
    Event.findById = () => ({
      lean: async () => ({
        _id: "event-1",
        skills: [" Planning ", "Planning"],
        scoringConfig: { scaleMin: 1, scaleMax: 5 },
      }),
    });
    Participant.findOne = () => ({ lean: async () => ({ email: "person@example.com" }) });
    FeedbackSubmission.findOne = async () => null;
    FeedbackSubmission.create = async (doc) => {
      saved = doc;
      return { _id: { toString: () => "sub-1" }, submittedAt: doc.submittedAt };
    };
    const response = captureResponse();
    await submitEventFeedback({
      params: { eventId: "event-1" },
      user: { email: "rater@example.com" },
      body: { targetEmail: "target@example.com", ratings: [{ skill: "planning", score: 4, skipped: false }] },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(saved.ratings.length, 1);
    assert.equal(saved.ratings[0].skill, "Planning");
  } finally {
    Event.findById = originals.findById;
    Participant.findOne = originals.findOne;
    FeedbackSubmission.findOne = originals.feedbackFindOne;
    FeedbackSubmission.create = originals.create;
  }
});

test("submitEventFeedback leaves an unmentioned skill unanswered", async () => {
  const originals = {
    findById: Event.findById,
    findOne: Participant.findOne,
    feedbackFindOne: FeedbackSubmission.findOne,
  };
  const existing = {
    ratings: [{ skill: "Planning", score: 4, skipped: false, comment: null }],
    submittedAt: new Date("2026-04-01T00:00:00.000Z"),
    _id: { toString: () => "sub-1" },
    async save() {},
  };
  try {
    Event.findById = () => ({
      lean: async () => ({
        _id: "event-1",
        skills: ["Planning", "Leadership", "Speaking"],
        scoringConfig: { scaleMin: 1, scaleMax: 5 },
      }),
    });
    Participant.findOne = () => ({ lean: async () => ({ email: "person@example.com" }) });
    FeedbackSubmission.findOne = async () => existing;
    const response = captureResponse();
    await submitEventFeedback({
      params: { eventId: "event-1" },
      user: { email: "rater@example.com" },
      body: { targetEmail: "target@example.com", ratings: [{ skill: "Leadership", score: 5, skipped: false }] },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      existing.ratings.map((rating) => ({ skill: rating.skill, score: rating.score, skipped: rating.skipped })),
      [
        { skill: "Planning", score: 4, skipped: false },
        { skill: "Leadership", score: 5, skipped: false },
      ]
    );
  } finally {
    Event.findById = originals.findById;
    Participant.findOne = originals.findOne;
    FeedbackSubmission.findOne = originals.feedbackFindOne;
  }
});

test("submitEventFeedback rejects a numeric score when the organizer has not set a scale", async () => {
  const originals = { findById: Event.findById, findOne: Participant.findOne };
  try {
    Event.findById = () => ({
      lean: async () => ({ _id: "event-1", skills: ["Planning"], scoringConfig: {} }),
    });
    Participant.findOne = () => ({ lean: async () => ({ email: "person@example.com" }) });
    const response = captureResponse();
    await submitEventFeedback({
      params: { eventId: "event-1" },
      user: { email: "rater@example.com" },
      body: { targetEmail: "target@example.com", ratings: [{ skill: "Planning", score: 8, skipped: false }] },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /scale is not configured/i);
  } finally {
    Event.findById = originals.findById;
    Participant.findOne = originals.findOne;
  }
});

test("registerForEvent keeps a roster name when the account name is blank", async () => {
  const originals = {
    findById: Event.findById,
    studentFindOne: Student.findOne,
    participantFindOne: Participant.findOne,
    updateOne: Participant.updateOne,
  };
  let written;
  try {
    Event.findById = async () => ({
      _id: "event-1",
      status: "PUBLISHED",
      levels: ["Volunteer"],
      committees: [{ name: "Ops", allowedLevels: ["Volunteer"] }],
    });
    Student.findOne = () => ({ lean: async () => ({ name: "  " }) });
    Participant.findOne = () => ({ lean: async () => null });
    Participant.updateOne = async (_filter, update) => {
      written = update;
    };
    const response = createResponse();
    await registerForEvent({
      user: { email: "student@example.com", name: "" },
      params: { eventId: "event-1" },
      body: { level: "Volunteer", committee: "Ops" },
    }, response);
    assert.equal(response.body.ok, true);
    assert.equal(written.$set.name, undefined);
    assert.equal(written.$set.level, "Volunteer");
    assert.equal(written.$set.committee, "Ops");
  } finally {
    Event.findById = originals.findById;
    Student.findOne = originals.studentFindOne;
    Participant.findOne = originals.participantFindOne;
    Participant.updateOne = originals.updateOne;
  }
});

test("registerForEvent stores the organizer spelling when the join labels differ only by case", async () => {
  const originals = {
    findById: Event.findById,
    studentFindOne: Student.findOne,
    participantFindOne: Participant.findOne,
    updateOne: Participant.updateOne,
  };
  let written;
  try {
    Event.findById = async () => ({
      _id: "event-1",
      status: "PUBLISHED",
      levels: ["Head"],
      committees: [{ name: "Ops", allowedLevels: ["head"] }],
    });
    Student.findOne = () => ({ lean: async () => ({ name: "Ada" }) });
    Participant.findOne = () => ({ lean: async () => null });
    Participant.updateOne = async (_filter, update) => {
      written = update;
    };
    const response = createResponse();
    await registerForEvent({
      user: { email: "student@example.com", name: "Ada" },
      params: { eventId: "event-1" },
      body: { level: "HEAD", committee: " ops " },
    }, response);
    assert.equal(response.body.ok, true);
    assert.equal(written.$set.level, "Head");
    assert.equal(written.$set.committee, "Ops");
  } finally {
    Event.findById = originals.findById;
    Student.findOne = originals.studentFindOne;
    Participant.findOne = originals.participantFindOne;
    Participant.updateOne = originals.updateOne;
  }
});

test("registerForEvent accepts a level saved on a repeated committee spelling", async () => {
  const originals = {
    findById: Event.findById,
    studentFindOne: Student.findOne,
    participantFindOne: Participant.findOne,
    updateOne: Participant.updateOne,
  };
  let written;
  try {
    Event.findById = async () => ({
      _id: "event-1",
      status: "PUBLISHED",
      levels: ["Head", " head ", "Volunteer"],
      committees: [
        { name: "Ops", allowedLevels: [] },
        { name: " ops ", allowedLevels: ["Head"] },
      ],
    });
    Student.findOne = () => ({ lean: async () => ({ name: "Ada" }) });
    Participant.findOne = () => ({ lean: async () => null });
    Participant.updateOne = async (_filter, update) => {
      written = update;
    };
    const response = createResponse();
    await registerForEvent({
      user: { email: "student@example.com" },
      params: { eventId: "event-1" },
      body: { level: "head", committee: "ops" },
    }, response);
    assert.equal(response.body.ok, true);
    assert.equal(written.$set.level, "Head");
    assert.equal(written.$set.committee, "Ops");

    const rejected = createResponse();
    await registerForEvent({
      user: { email: "student@example.com" },
      params: { eventId: "event-1" },
      body: { level: "Volunteer", committee: "Ops" },
    }, rejected);
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.body.message, /committee/i);
  } finally {
    Event.findById = originals.findById;
    Student.findOne = originals.studentFindOne;
    Participant.findOne = originals.participantFindOne;
    Participant.updateOne = originals.updateOne;
  }
});

test("registerForEvent updates a roster row whose email differs only by case", async () => {
  const originals = {
    findById: Event.findById,
    studentFindOne: Student.findOne,
    participantFindOne: Participant.findOne,
    updateOne: Participant.updateOne,
  };
  let filter;
  let written;
  try {
    Event.findById = async () => ({
      _id: "event-1",
      status: "PUBLISHED",
      levels: ["Volunteer"],
      committees: [{ name: "Ops", allowedLevels: ["Volunteer"] }],
    });
    Student.findOne = () => ({ lean: async () => ({ name: "Ada" }) });
    Participant.findOne = (query) => ({
      lean: async () => {
        assert.equal(query.$expr.$eq[1], "student@example.com");
        return { _id: "row-1", email: "Student@Example.com" };
      },
    });
    Participant.updateOne = async (query, update) => {
      filter = query;
      written = update;
    };
    const response = createResponse();
    await registerForEvent({
      user: { email: " Student@Example.com " },
      params: { eventId: "event-1" },
      body: { level: "Volunteer", committee: "Ops" },
    }, response);
    assert.equal(response.body.ok, true);
    assert.equal(filter._id, "row-1");
    assert.equal(written.$set.email, "student@example.com");
    assert.equal(written.$setOnInsert, undefined);
  } finally {
    Event.findById = originals.findById;
    Student.findOne = originals.studentFindOne;
    Participant.findOne = originals.participantFindOne;
    Participant.updateOne = originals.updateOne;
  }
});

test("registerForEvent rejects an event after its end date", async () => {
  const original = Event.findById;
  try {
    Event.findById = async () => ({
      status: "PUBLISHED",
      eventEndDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      levels: ["Head"],
      committees: [{ name: "Ops", allowedLevels: ["Head"] }],
    });
    const response = createResponse();
    await registerForEvent({
      user: { email: "student@example.com" },
      params: { eventId: "event-1" },
      body: { level: "Head", committee: "Ops" },
    }, response);
    assert.equal(response.statusCode, 404);
    assert.match(response.body.message, /open event/i);
  } finally {
    Event.findById = original;
  }
});

test("registerForEvent rejects a level that the event does not offer", async () => {
  const original = Event.findById;
  Event.findById = async () => ({
    status: "PUBLISHED",
    levels: ["Head"],
    committees: [{ name: "Ops", allowedLevels: ["Head"] }],
  });
  try {
    const response = createResponse();
    await registerForEvent({
      user: { email: "student@example.com" },
      params: { eventId: "64f000000000000000000001" },
      body: { level: "Volunteer", committee: "Ops" },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /level/i);
  } finally {
    Event.findById = original;
  }
});

test("compareLeaderboardRows puts the higher score first and breaks ties by name", () => {
  const rows = [
    { name: "Bea", score: 8 },
    { name: "ada", score: 8 },
    { name: "Cara", score: 9 },
  ].sort(compareLeaderboardRows);
  assert.deepEqual(rows.map((row) => row.name), ["Cara", "ada", "Bea"]);
});

test("overallScaleBoards keeps each rating scale in its own ranking", () => {
  const boards = overallScaleBoards([
    { name: "Ada", score: 6, scaleMin: 1, scaleMax: 10 },
    { name: "Ben", score: 5, scaleMin: 0, scaleMax: 5 },
    { name: "Cara", score: 9, scaleMin: 1, scaleMax: 10 },
  ]);
  assert.deepEqual(boards.map((board) => board.title), ["Overall on 0–5", "Overall on 1–10"]);
  assert.deepEqual(boards[0].rows.map((row) => row.name), ["Ben"]);
  assert.deepEqual(boards[1].rows.map((row) => row.name), ["Cara", "Ada"]);

  const shared = overallScaleBoards([
    { name: "Bea", score: 4, scaleMin: 1, scaleMax: 10 },
    { name: "Ada", score: 8, scaleMin: 1, scaleMax: 10 },
  ]);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].title, "Overall");
  assert.deepEqual(shared[0].rows.map((row) => row.name), ["Ada", "Bea"]);
});

test("rankedOverall does not place a higher raw score from another scale first", () => {
  const ranked = rankedOverall([
    { name: "Ada", score: 6, scaleMin: 1, scaleMax: 10 },
    { name: "Ben", score: 5, scaleMin: 0, scaleMax: 5 },
    { name: "Cara", score: 9, scaleMin: 1, scaleMax: 10 },
  ]);
  assert.deepEqual(ranked.overall.map((row) => row.name), ["Ben", "Cara", "Ada"]);
  assert.deepEqual(ranked.overallBoards.map((board) => board.title), ["Overall on 0–5", "Overall on 1–10"]);
});

test("getLeaderboard keeps a closed score when the frozen email differs only by case", async () => {
  const originals = {
    eventFind: Event.find,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    studentFind: Student.find,
    studentFindOne: Student.findOne,
  };
  const eventId = "64f000000000000000000009";
  try {
    Student.findOne = () => ({ select: () => ({ lean: async () => ({ universityId: { toString: () => "uni-home" } }) }) });
    Student.find = () => ({
      select: () => ({ lean: async () => [{ email: "Ada@Example.com", name: "Ada Lovelace", photoUrl: "https://cdn.example/ada.jpg" }] }),
    });
    Participant.find = (query) => queryResult(
      query.$expr
        ? [{ eventId }]
        : [{ email: "ada@example.com", name: "Roster Ada", level: "Member", committee: "Ops" }]
    );
    FeedbackSubmission.find = () => queryResult([]);
    Event.find = () => queryResult([{
      _id: { toString: () => eventId },
      name: "Closed Fest",
      status: "CLOSED",
      skills: ["Planning"],
      universityId: { toString: () => "uni-home" },
      frozenScores: {
        configured: true,
        eligible: true,
        scaleMin: 1,
        scaleMax: 10,
        crossEventRule: "equal",
        participants: [{
          email: "Ada@Example.com",
          eventScore: 7,
          confidence: 0.4,
          status: "READY",
          scaleMin: 1,
          scaleMax: 10,
        }],
      },
    }]);
    const response = createResponse();
    await getLeaderboard({ user: { email: "ada@example.com" } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.events[0].rows[0].name, "Ada Lovelace");
    assert.equal(response.body.events[0].rows[0].photoUrl, "https://cdn.example/ada.jpg");
    assert.equal(response.body.events[0].rows[0].score, 7);
    assert.equal(response.body.overall[0].score, 7);
    assert.equal(response.body.overall[0].name, "Ada Lovelace");
  } finally {
    Event.find = originals.eventFind;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Student.find = originals.studentFind;
    Student.findOne = originals.studentFindOne;
  }
});

test("getLeaderboard shows the student's university and joined events only", async () => {
  const originals = {
    eventFind: Event.find,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    studentFind: Student.find,
    studentFindOne: Student.findOne,
  };
  const homeId = "64f000000000000000000001";
  const joinedId = "64f000000000000000000002";
  const foreignId = "64f000000000000000000003";
  const event = (id, name, universityId) => ({
    _id: { toString: () => id },
    name,
    status: "PUBLISHED",
    skills: [],
    universityId: { toString: () => universityId },
    scoringConfig: {},
  });
  try {
    let lookedUpEmail = null;
    Student.findOne = (query) => {
      lookedUpEmail = query.$expr.$eq[1];
      return { select: () => ({ lean: async () => ({ universityId: { toString: () => "uni-home" } }) }) };
    };
    Student.find = () => ({
      select: () => ({ lean: async () => [{ email: "student@example.com", name: "Ada" }] }),
    });
    Participant.find = (query) => queryResult(
      query.$expr
        ? [{ eventId: joinedId }]
        : [{ email: "student@example.com", level: "Member", committee: "Ops" }]
    );
    FeedbackSubmission.find = () => queryResult([]);
    let eventQuery = null;
    Event.find = (query) => {
      eventQuery = query;
      const clauses = query.$or || [];
      const universities = new Set(clauses.map((clause) => clause.universityId?.toString()).filter(Boolean));
      const ids = new Set(clauses.flatMap((clause) => clause._id?.$in || []).map(String));
      return queryResult([
        event(homeId, "Home Fest", "uni-home"),
        event(joinedId, "Away Fest", "uni-away"),
        event(foreignId, "Secret Fest", "uni-other"),
      ].filter((item) => universities.has(item.universityId.toString()) || ids.has(item._id.toString())));
    };

    const response = createResponse();
    await getLeaderboard({ user: { email: "student@example.com" } }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(lookedUpEmail, "student@example.com");
    assert.equal(eventQuery.$or.some((clause) => clause.universityId?.toString() === "uni-home"), true);
    assert.equal(eventQuery.$or.some((clause) => (clause._id?.$in || []).map(String).includes(joinedId)), true);
    const names = response.body.events.map((item) => item.eventName).sort();
    assert.deepStrictEqual(names, ["Away Fest", "Home Fest"]);
    assert.equal(JSON.stringify(response.body).includes("Secret Fest"), false);
    assert.equal(response.body.events.every((item) => item.auditStatus === "not_configured"), true);
  } finally {
    Event.find = originals.eventFind;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Student.find = originals.studentFind;
    Student.findOne = originals.studentFindOne;
  }
});

test("getLeaderboard marks an open event rank as still collecting", async () => {
  const originals = {
    eventFind: Event.find,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    studentFind: Student.find,
    studentFindOne: Student.findOne,
  };
  const scoringConfig = {
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
    evenMedianRule: "average",
    allowSelfRatings: false,
    blankSkillPolicy: "ignoreSkill",
    unscoredSkillPolicy: "exclude",
    crossEventRule: "equal",
    contributesToScoring: true,
  };
  try {
    Student.findOne = () => ({
      select: () => ({ lean: async () => ({ universityId: { toString: () => "uni-home" } }) }),
    });
    Student.find = () => ({
      select: () => ({ lean: async () => [{ email: "rater@example.com", name: "Rater" }] }),
    });
    Participant.find = (query) => queryResult(query.email ? [] : [
      { email: "student@example.com", name: "Ada", level: "Member", committee: "Ops" },
      { email: "rater@example.com", level: "Member", committee: "Ops" },
    ]);
    FeedbackSubmission.find = () => queryResult([{
      raterEmail: "rater@example.com",
      targetEmail: "student@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
      submittedAt: new Date(),
    }]);
    Event.find = () => queryResult([{
      _id: { toString: () => "event-open" },
      name: "Home Fest",
      status: "PUBLISHED",
      skills: ["Planning"],
      universityId: { toString: () => "uni-home" },
      scoringConfig,
    }]);
    const response = createResponse();
    await getLeaderboard({ user: { email: "student@example.com" } }, response);
    assert.equal(response.body.overall.length, 1);
    assert.equal(response.body.overall[0].name, "Ada");
    assert.equal(response.body.events[0].rows[0].name, "Ada");
    assert.equal(response.body.overall[0].score, 8);
    assert.equal(response.body.overall[0].auditStatus, "collecting");
    assert.equal(response.body.overall[0].email, undefined);
    assert.equal(response.body.overallBoards.length, 1);
    assert.equal(response.body.overallBoards[0].title, "Overall");
    assert.equal(response.body.overallBoards[0].rows[0].name, "Ada");
    assert.equal(response.body.events[0].auditStatus, "collecting");
  } finally {
    Event.find = originals.eventFind;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Student.find = originals.studentFind;
    Student.findOne = originals.studentFindOne;
  }
});

test("getLeaderboard uses a roster name from a later event when an earlier row is blank", async () => {
  const originals = {
    eventFind: Event.find,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    studentFind: Student.find,
    studentFindOne: Student.findOne,
  };
  const scoringConfig = {
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
    evenMedianRule: "average",
    allowSelfRatings: false,
    blankSkillPolicy: "ignoreSkill",
    unscoredSkillPolicy: "exclude",
    crossEventRule: "equal",
    contributesToScoring: true,
  };
  const event = (id, name) => ({
    _id: { toString: () => id },
    name,
    status: "PUBLISHED",
    skills: ["Planning"],
    universityId: { toString: () => "uni-home" },
    scoringConfig,
  });
  try {
    Student.findOne = () => ({
      select: () => ({ lean: async () => ({ universityId: { toString: () => "uni-home" } }) }),
    });
    Student.find = () => ({ select: () => ({ lean: async () => [] }) });
    Participant.find = (query) => queryResult(query.email ? [] : [
      { email: "student@example.com", name: String(query.eventId) === "event-early" ? "" : "Ada", level: "Member", committee: "Ops" },
      { email: "rater@example.com", name: "Rater", level: "Member", committee: "Ops" },
    ]);
    FeedbackSubmission.find = () => queryResult([{
      raterEmail: "rater@example.com",
      targetEmail: "student@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
      submittedAt: new Date(),
    }]);
    Event.find = () => queryResult([
      event("event-early", "Early Fest"),
      event("event-late", "Late Fest"),
    ]);
    const response = createResponse();
    await getLeaderboard({ user: { email: "student@example.com" } }, response);
    const early = response.body.events.find((item) => item.eventName === "Early Fest");
    const late = response.body.events.find((item) => item.eventName === "Late Fest");
    assert.equal(early.rows.find((row) => row.score === 8).name, "Ada");
    assert.equal(late.rows.find((row) => row.score === 8).name, "Ada");
    assert.equal(JSON.stringify(response.body).includes("student@example.com"), false);
    assert.equal(response.body.overall[0].name, "Ada");
  } finally {
    Event.find = originals.eventFind;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Student.find = originals.studentFind;
    Student.findOne = originals.studentFindOne;
  }
});

test("getLeaderboard uses an account name when the saved email has extra spaces", async () => {
  const originals = {
    eventFind: Event.find,
    participantFind: Participant.find,
    feedbackFind: FeedbackSubmission.find,
    studentFind: Student.find,
    studentFindOne: Student.findOne,
  };
  const scoringConfig = {
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
    evenMedianRule: "average",
    allowSelfRatings: false,
    blankSkillPolicy: "ignoreSkill",
    unscoredSkillPolicy: "exclude",
    crossEventRule: "equal",
    contributesToScoring: true,
  };
  try {
    Student.findOne = () => ({
      select: () => ({ lean: async () => ({ universityId: { toString: () => "uni-home" } }) }),
    });
    let accountQuery = null;
    Student.find = (criteria) => {
      accountQuery = criteria;
      return {
        select: () => ({
          lean: async () => [{
            email: "  Ada @Example.com  ",
            name: "Ada Lovelace",
            photoUrl: "https://cdn.example.com/ada.jpg",
          }],
        }),
      };
    };
    Participant.find = (query) => queryResult(query.email ? [] : [
      { email: "ada@example.com", name: "", level: "Member", committee: "Ops" },
      { email: "rater@example.com", name: "Rater", level: "Member", committee: "Ops" },
    ]);
    FeedbackSubmission.find = () => queryResult([{
      raterEmail: "rater@example.com",
      targetEmail: "ada@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
      submittedAt: new Date(),
    }]);
    Event.find = () => queryResult([{
      _id: { toString: () => "event-1" },
      name: "Launch Fest",
      status: "PUBLISHED",
      skills: ["Planning"],
      universityId: { toString: () => "uni-home" },
      scoringConfig,
    }]);
    const response = createResponse();
    await getLeaderboard({ user: { email: "student@example.com" } }, response);
    const ranked = response.body.events[0].rows.find((row) => row.score === 8);
    assert.equal(ranked.name, "Ada Lovelace");
    assert.equal(ranked.photoUrl, "https://cdn.example.com/ada.jpg");
    assert.deepEqual(accountQuery.$expr.$in[1].sort(), ["ada@example.com", "rater@example.com"]);
    assert.equal(JSON.stringify(accountQuery).includes("$replaceAll"), true);
    assert.equal(response.body.overall[0].name, "Ada Lovelace");
    assert.equal(JSON.stringify(response.body).includes("Ada@Example.com"), false);
  } finally {
    Event.find = originals.eventFind;
    Participant.find = originals.participantFind;
    FeedbackSubmission.find = originals.feedbackFind;
    Student.find = originals.studentFind;
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
