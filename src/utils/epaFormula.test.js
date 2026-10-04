const test = require("node:test");
const assert = require("node:assert/strict");
const { missingSettings, scoreEvent, combineOverall, auditStatus, uniqueParticipants, alignScoringConfigToStructure } = require("./epaFormula");

function config(overrides = {}) {
  return {
    scaleMin: 1,
    scaleMax: 10,
    levelRanks: { Volunteer: 1, Head: 4 },
    levelInfluence: 0,
    committeeWeightSame: 1,
    committeeWeightTop: 1,
    committeeWeightOther: 1,
    relevance: { Ops: { Planning: 1, Speaking: 1 }, Tech: { Planning: 1, Speaking: 1 } },
    credibilityEpsilon: 0.05,
    credibilityShrinkage: 5,
    confidencePrior: 5,
    skillWeights: { Planning: 1, Speaking: 1 },
    applyRelevanceToSkillWeights: false,
    evenMedianRule: "average",
    allowSelfRatings: false,
    blankSkillPolicy: "ignoreSkill",
    unscoredSkillPolicy: "exclude",
    crossEventRule: "equal",
    contributesToScoring: true,
    ...overrides,
  };
}

test("audit status separates collecting, provisional, final, and a stale snapshot", () => {
  assert.equal(auditStatus({ configured: false, participants: [] }), "not_configured");
  assert.equal(auditStatus({ eligible: false, configured: true, participants: [] }), "not_eligible");
  assert.equal(auditStatus({ configured: true, eligible: true, participants: [{ status: "READY" }] }), "collecting");
  assert.equal(auditStatus({ configured: true, eligible: true, participants: [{ status: "PROVISIONAL" }] }), "provisional");
  assert.equal(auditStatus({ configured: true, eligible: true, formulaVersion: "epa-reindexed-v1", participants: [] }, { closed: true }), "final");
  assert.equal(auditStatus({ configured: true, eligible: true, formulaVersion: "epa-v1", participants: [] }, { closed: true }), "recalculation_required");
  assert.equal(auditStatus({ configured: true, eligible: true, participants: [] }, { closed: true }), "recalculation_required");
});

test("a blank or boolean rating scale is missing and is not treated as zero", () => {
  assert.ok(missingSettings(config({ scaleMin: null })).includes("scaleMin"));
  assert.ok(missingSettings(config({ scaleMin: "" })).includes("scaleMin"));
  assert.ok(missingSettings(config({ scaleMin: false })).includes("scaleMin"));
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [{ email: "a@b.com", level: "Head", committee: "Ops" }],
    submissions: [],
    config: config({ scaleMin: false }),
  });
  assert.equal(result.configured, false);
  assert.equal(result.participants[0].eventScore, null);
});

test("a participant without a level or committee produces no score", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "a@b.com", level: "", committee: "" },
      { email: "c@d.com", level: "Head", committee: "Ops" },
    ],
    submissions: [],
    config: config(),
  });
  assert.equal(result.configured, false);
  assert.equal(result.participants.every((person) => person.eventScore === null), true);
  assert.ok(result.missing.includes("levelRank"));
  assert.ok(result.missing.includes("committee"));
});

test("duplicate participant rows keep the name and the role", () => {
  const rows = uniqueParticipants([
    { email: "Ada@x.com", name: "Ada", level: "", committee: "" },
    { email: "ada@x.com", name: "", level: "Head", committee: "Ops" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "ada@x.com");
  assert.equal(rows[0].name, "Ada");
  assert.equal(rows[0].level, "Head");
  assert.equal(rows[0].committee, "Ops");
});

test("duplicate participant rows combine a level from one row with a committee from the other", () => {
  const rows = uniqueParticipants([
    { email: "ada@x.com", name: "Ada", level: "Head", committee: "" },
    { email: "ada@x.com", name: "", level: "", committee: "Ops" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, "Head");
  assert.equal(rows[0].committee, "Ops");
  assert.equal(rows[0].name, "Ada");
});

test("duplicate participant rows are scored once", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "Target@Example.com", level: "", committee: "" },
      { email: "target@example.com", level: "Head", committee: "Ops" },
      { email: "rater@example.com", level: "Head", committee: "Ops" },
    ],
    submissions: [{
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
    }],
    config: config(),
  });
  const matches = result.participants.filter((person) => person.email === "target@example.com");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].eventScore, 8);
});

test("a negative skill weight produces no score", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "a@b.com", level: "Head", committee: "Ops" },
      { email: "c@d.com", level: "Head", committee: "Ops" },
    ],
    submissions: [],
    config: config({ skillWeights: { Planning: -1, Speaking: 1 } }),
  });
  assert.equal(result.configured, false);
  assert.equal(result.participants.every((person) => person.eventScore === null), true);
  assert.ok(result.missing.includes("nonNegative:skillWeight:Planning"));
});

test("a negative committee weight produces no score", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "a@b.com", level: "Head", committee: "Ops" },
      { email: "c@d.com", level: "Head", committee: "Ops" },
    ],
    submissions: [{
      raterEmail: "c@d.com",
      targetEmail: "a@b.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
    }],
    config: config({ committeeWeightSame: -1 }),
  });
  assert.equal(result.configured, false);
  assert.ok(result.missing.includes("nonNegative:committeeWeightSame"));
  assert.equal(result.participants[0].eventScore, null);
});

test("a negative relevance produces no score", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "a@b.com", level: "Head", committee: "Ops" },
      { email: "c@d.com", level: "Head", committee: "Ops" },
    ],
    submissions: [{
      raterEmail: "c@d.com",
      targetEmail: "a@b.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
    }],
    config: config({ relevance: { Ops: { Planning: -1, Speaking: 1 }, Tech: { Planning: 1, Speaking: 1 } } }),
  });
  assert.equal(result.configured, false);
  assert.ok(result.missing.includes("nonNegative:relevance:Ops:Planning"));
  assert.equal(result.participants[0].eventScore, null);
});

test("an inverted scale produces no score", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "target@example.com", level: "Volunteer", committee: "Ops" },
      { email: "rater@example.com", level: "Volunteer", committee: "Ops" },
    ],
    submissions: [{
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
    }],
    config: config({ scaleMin: 10, scaleMax: 1 }),
  });
  assert.equal(result.configured, false);
  assert.ok(result.missing.includes("scaleRange"));
  assert.equal(result.participants[0].eventScore, null);
});

test("missing settings produce no score", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [{ email: "a@example.com", level: "Volunteer", committee: "Ops" }],
    submissions: [],
    config: { scaleMin: 1 },
  });
  assert.equal(result.configured, false);
  assert.equal(result.participants[0].eventScore, null);
  assert.ok(result.missing.includes("scaleMax"));
  assert.equal(missingSettings(null)[0], "scoringConfig");
});

test("a rating a hair past the scale still counts and a clearly higher rating does not", () => {
  const accepted = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "target@example.com", level: "Volunteer", committee: "Ops" },
      { email: "rater@example.com", level: "Volunteer", committee: "Ops" },
    ],
    submissions: [{
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 10.0000001, skipped: false }],
    }],
    config: config(),
  });
  const target = accepted.participants.find((person) => person.email === "target@example.com");
  assert.equal(target.status, "READY");
  assert.ok(Math.abs(target.eventScore - 10) < 1e-6);

  const rejected = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "target@example.com", level: "Volunteer", committee: "Ops" },
      { email: "rater@example.com", level: "Volunteer", committee: "Ops" },
    ],
    submissions: [{
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 10.2, skipped: false }],
    }],
    config: config(),
  });
  const unscored = rejected.participants.find((person) => person.email === "target@example.com");
  assert.equal(unscored.eventScore, null);
});

test("one valid rating round-trips through the admin scale", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "Target@example.com", level: "Volunteer", committee: "Ops" },
      { email: "rater@example.com", level: "Volunteer", committee: "Ops" },
    ],
    submissions: [{
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
    }],
    config: config(),
  });
  const target = result.participants.find((person) => person.email === "target@example.com");
  assert.equal(target.status, "READY");
  assert.ok(Math.abs(target.eventScore - 8) < 1e-9);
  assert.ok(target.confidence > 0 && target.confidence < 1);
});

test("a review whose emails contain a space still scores the roster person", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "target@example.com", level: "Volunteer", committee: "Ops" },
      { email: "rater@example.com", level: "Volunteer", committee: "Ops" },
    ],
    submissions: [{
      raterEmail: "ra ter@example.com",
      targetEmail: "tar get@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
    }],
    config: config(),
  });
  const target = result.participants.find((person) => person.email === "target@example.com");
  assert.equal(target.status, "READY");
  assert.ok(Math.abs(target.eventScore - 8) < 1e-9);
  assert.equal(result.coverage.submittedReviews, 1);
});

test("organizer settings are returned under the event's own spelling", () => {
  const aligned = alignScoringConfigToStructure({
    levelRanks: { " head ": "", head: 4 },
    skillWeights: { Planning: "", planning: 2 },
    relevance: { " ops ": { Planning: "" }, ops: { planning: 1 } },
  }, {
    levels: ["Head"],
    skills: ["Planning"],
    committees: [{ name: "Ops", allowedLevels: ["Head"] }],
  });
  assert.deepEqual(aligned.levelRanks, { Head: 4 });
  assert.deepEqual(aligned.skillWeights, { Planning: 2 });
  assert.deepEqual(aligned.relevance, { Ops: { Planning: 1 } });
});

test("a filled setting is used when the same label was also saved blank", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "target@example.com", level: "HEAD", committee: "OPS" },
      { email: "rater@example.com", level: "head", committee: "ops" },
    ],
    submissions: [{
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
    }],
    config: config({
      levelRanks: { Head: "", head: 4 },
      relevance: { Ops: { Planning: "" }, ops: { planning: 1 } },
      skillWeights: { Planning: "", planning: 1 },
    }),
  });
  const target = result.participants.find((person) => person.email === "target@example.com");
  assert.equal(result.configured, true);
  assert.equal(target.status, "READY");
  assert.ok(Math.abs(target.eventScore - 8) < 1e-9);
});

test("role and skill labels match the organizer spelling regardless of case", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "target@example.com", level: "head", committee: "ops" },
      { email: "rater@example.com", level: "HEAD", committee: "OPS" },
    ],
    submissions: [{
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "planning", score: 8, skipped: false }],
    }],
    config: config({
      levelRanks: { Head: 4 },
      relevance: { Ops: { planning: 1 } },
      skillWeights: { planning: 1 },
    }),
  });
  const target = result.participants.find((person) => person.email === "target@example.com");
  assert.equal(result.configured, true);
  assert.equal(target.status, "READY");
  assert.ok(Math.abs(target.eventScore - 8) < 1e-9);
});

test("a repeated skill name is scored once", () => {
  const participants = [
    { email: "target@example.com", level: "Volunteer", committee: "Ops" },
    { email: "rater@example.com", level: "Volunteer", committee: "Ops" },
  ];
  const submissions = [{
    raterEmail: "rater@example.com",
    targetEmail: "target@example.com",
    ratings: [{ skill: "Planning", score: 8, skipped: false }],
  }];
  const once = scoreEvent({ skills: ["Planning"], participants, submissions, config: config() });
  const twice = scoreEvent({ skills: ["Planning", " Planning ", "planning", ""], participants, submissions, config: config() });
  const single = once.participants.find((person) => person.email === "target@example.com");
  const repeated = twice.participants.find((person) => person.email === "target@example.com");
  assert.equal(repeated.skills.length, 1);
  assert.equal(repeated.skills[0].skill, "Planning");
  assert.ok(Math.abs(repeated.eventScore - single.eventScore) < 1e-9);
});

test("self ratings stay out when the admin disallows them and a skip is not a zero", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "target@example.com", level: "Volunteer", committee: "Ops" },
      { email: "rater@example.com", level: "Volunteer", committee: "Ops" },
    ],
    submissions: [
      {
        raterEmail: "target@example.com",
        targetEmail: "target@example.com",
        ratings: [{ skill: "Planning", score: 1, skipped: false }],
      },
      {
        raterEmail: "rater@example.com",
        targetEmail: "target@example.com",
        ratings: [{ skill: "Planning", score: null, skipped: true }],
      },
    ],
    config: config({ allowSelfRatings: false }),
  });
  const target = result.participants.find((person) => person.email === "target@example.com");
  assert.equal(target.eventScore, null);
  assert.equal(target.reason, "no_ratings");
});

test("a review for a removed skill does not count toward the minimum", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "target@example.com", level: "Volunteer", committee: "Ops" },
      { email: "rater@example.com", level: "Volunteer", committee: "Ops" },
      { email: "old@example.com", level: "Volunteer", committee: "Ops" },
    ],
    submissions: [
      { raterEmail: "rater@example.com", targetEmail: "target@example.com", ratings: [{ skill: "Planning", score: 8, skipped: false }] },
      { raterEmail: "old@example.com", targetEmail: "target@example.com", ratings: [{ skill: "OldSkill", score: 8, skipped: false }] },
    ],
    config: config({ minimumRatings: 2 }),
  });
  const target = result.participants.find((person) => person.email === "target@example.com");
  assert.equal(target.reviewCount, 1);
  assert.equal(target.status, "PROVISIONAL");
  assert.equal(result.coverage.submittedReviews, 1);
});

test("a blank score is absent even when the scale includes zero", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "target@example.com", level: "Volunteer", committee: "Ops" },
      { email: "rater@example.com", level: "Volunteer", committee: "Ops" },
    ],
    submissions: [{
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: null, skipped: false }],
    }],
    config: config({ scaleMin: 0, scaleMax: 10 }),
  });
  const target = result.participants.find((person) => person.email === "target@example.com");
  assert.equal(target.eventScore, null);
  assert.equal(target.reason, "no_ratings");

  const whitespace = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "target@example.com", level: "Volunteer", committee: "Ops" },
      { email: "rater@example.com", level: "Volunteer", committee: "Ops" },
    ],
    submissions: [{
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: "  ", skipped: false }],
    }],
    config: config({ scaleMin: 0, scaleMax: 10 }),
  });
  const blankTarget = whitespace.participants.find((person) => person.email === "target@example.com");
  assert.equal(blankTarget.eventScore, null);
  assert.equal(blankTarget.reason, "no_ratings");
});

test("event confidence uses the same skill weights as event EPA", () => {
  const result = scoreEvent({
    skills: ["Planning", "Speaking"],
    participants: [
      { email: "target@example.com", level: "Volunteer", committee: "Ops" },
      { email: "a@example.com", level: "Volunteer", committee: "Ops" },
      { email: "b@example.com", level: "Volunteer", committee: "Ops" },
    ],
    submissions: [
      {
        raterEmail: "a@example.com",
        targetEmail: "target@example.com",
        ratings: [
          { skill: "Planning", score: 8, skipped: false },
          { skill: "Speaking", score: 8, skipped: false },
        ],
      },
      {
        raterEmail: "b@example.com",
        targetEmail: "target@example.com",
        ratings: [{ skill: "Planning", score: 8, skipped: false }],
      },
    ],
    config: config({ skillWeights: { Planning: 3, Speaking: 1 } }),
  });
  const target = result.participants.find((person) => person.email === "target@example.com");
  const planning = target.skills.find((skill) => skill.skill === "Planning");
  const speaking = target.skills.find((skill) => skill.skill === "Speaking");
  const weighted = (3 * planning.confidence + speaking.confidence) / 4;
  const equal = (planning.confidence + speaking.confidence) / 2;
  assert.ok(Math.abs(target.confidence - weighted) < 1e-9);
  assert.ok(Math.abs(weighted - equal) > 1e-6);
});

test("a higher-ranked rater changes the score only through the admin level influence", () => {
  const participants = [
    { email: "target@example.com", level: "Volunteer", committee: "Ops" },
    { email: "peer@example.com", level: "Volunteer", committee: "Ops" },
    { email: "head@example.com", level: "Head", committee: "Tech" },
  ];
  const submissions = [
    { raterEmail: "peer@example.com", targetEmail: "target@example.com", ratings: [{ skill: "Planning", score: 2, skipped: false }] },
    { raterEmail: "head@example.com", targetEmail: "target@example.com", ratings: [{ skill: "Planning", score: 10, skipped: false }] },
    { raterEmail: "peer@example.com", targetEmail: "head@example.com", ratings: [{ skill: "Planning", score: 6, skipped: false }] },
    { raterEmail: "head@example.com", targetEmail: "peer@example.com", ratings: [{ skill: "Planning", score: 6, skipped: false }] },
    { raterEmail: "target@example.com", targetEmail: "peer@example.com", ratings: [{ skill: "Planning", score: 6, skipped: false }] },
    { raterEmail: "target@example.com", targetEmail: "head@example.com", ratings: [{ skill: "Planning", score: 6, skipped: false }] },
  ];
  const flat = scoreEvent({ skills: ["Planning"], participants, submissions, config: config({ levelInfluence: 0, committeeWeightOther: 1, committeeWeightTop: 1 }) });
  const tilted = scoreEvent({ skills: ["Planning"], participants, submissions, config: config({ levelInfluence: 2, committeeWeightOther: 1, committeeWeightTop: 1 }) });
  const flatScore = flat.participants.find((person) => person.email === "target@example.com").eventScore;
  const tiltedScore = tilted.participants.find((person) => person.email === "target@example.com").eventScore;
  assert.ok(tiltedScore > flatScore);
});

test("zero relevance produces no numeric score", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "target@example.com", level: "Volunteer", committee: "Ops" },
      { email: "rater@example.com", level: "Volunteer", committee: "Ops" },
    ],
    submissions: [{
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
    }],
    config: config({ relevance: { Ops: { Planning: 0 }, Tech: { Planning: 0 } } }),
  });
  const target = result.participants.find((person) => person.email === "target@example.com");
  assert.equal(target.skills[0].reason, "zero_weight");
  assert.equal(target.eventScore, null);
});

test("cross-event combination follows the saved rule and refuses mixed rules", () => {
  assert.equal(combineOverall([
    { status: "READY", eventScore: 4, confidence: 0.5, scaleMin: 1, scaleMax: 10, crossEventRule: "equal" },
    { status: "READY", eventScore: 8, confidence: 0.5, scaleMin: 1, scaleMax: 10, crossEventRule: "equal" },
  ]).score, 6);
  assert.equal(combineOverall([
    { status: "READY", eventScore: 8, confidence: 1, scaleMin: 1, scaleMax: 10, crossEventRule: "none" },
  ]).reason, "cross_event_disabled");
  assert.equal(combineOverall([
    { status: "READY", eventScore: 8, confidence: 1, scaleMin: 1, scaleMax: 10, crossEventRule: "equal" },
    { status: "READY", eventScore: 4, confidence: 1, scaleMin: 0, scaleMax: 10, crossEventRule: "equal" },
  ]).reason, "mixed_scales");
  assert.equal(combineOverall([
    { status: "READY", eventScore: 8, confidence: 1, scaleMin: 1, scaleMax: 10, crossEventRule: "equal" },
    { status: "READY", eventScore: 4, confidence: 1, scaleMin: 1, scaleMax: 10, crossEventRule: "confidence" },
  ]).reason, "mixed_cross_event_rules");
  assert.equal(combineOverall([
    { status: "READY", eventScore: 8, confidence: 1, scaleMin: 1, scaleMax: 10, crossEventRule: "equal" },
    { status: "READY", eventScore: 4, confidence: 1, scaleMin: 1, scaleMax: 10, crossEventRule: "none" },
  ]).score, 8);
  assert.equal(combineOverall([
    { status: "READY", eventScore: 8, confidence: 1, scaleMin: 1, scaleMax: 10, crossEventRule: "equal" },
    { status: "NOT_ELIGIBLE", eventScore: null, confidence: null, scaleMin: 1, scaleMax: 10, crossEventRule: "confidence" },
    { status: "NOT_CONFIGURED", eventScore: null, confidence: null, scaleMin: 1, scaleMax: 10, crossEventRule: "none" },
  ]).score, 8);
});

test("an event stays unscored until the organizer says it contributes", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "target@example.com", level: "Volunteer", committee: "Ops" },
      { email: "rater@example.com", level: "Volunteer", committee: "Ops" },
    ],
    submissions: [{
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
    }],
    config: config({ contributesToScoring: undefined }),
  });
  assert.equal(result.configured, false);
  assert.ok(result.missing.includes("contributesToScoring"));
  assert.equal(result.participants[0].eventScore, null);
});

test("turning scoring off keeps the review count and removes the numeric score", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "target@example.com", level: "Volunteer", committee: "Ops" },
      { email: "rater@example.com", level: "Volunteer", committee: "Ops" },
    ],
    submissions: [{
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
    }],
    config: config({ contributesToScoring: false }),
  });
  assert.equal(result.eligible, false);
  assert.equal(result.coverage.submittedReviews, 1);
  assert.equal(result.coverage.expectedReviews, 2);
  assert.equal(result.participants[0].status, "NOT_ELIGIBLE");
  assert.equal(result.participants[0].eventScore, null);
});

test("a submitted review counts toward rater volume even when that skill was skipped", () => {
  const participants = [
    { email: "target@example.com", level: "Volunteer", committee: "Ops" },
    { email: "other@example.com", level: "Volunteer", committee: "Ops" },
    { email: "rater-a@example.com", level: "Volunteer", committee: "Ops" },
    { email: "rater-b@example.com", level: "Volunteer", committee: "Ops" },
  ];
  const base = [
    { raterEmail: "rater-a@example.com", targetEmail: "target@example.com", ratings: [{ skill: "Planning", score: 10, skipped: false }] },
    { raterEmail: "rater-a@example.com", targetEmail: "other@example.com", ratings: [{ skill: "Planning", score: 10, skipped: false }] },
    { raterEmail: "rater-b@example.com", targetEmail: "target@example.com", ratings: [{ skill: "Planning", score: 1, skipped: false }] },
  ];
  const withSkip = [
    ...base,
    { raterEmail: "rater-a@example.com", targetEmail: "rater-b@example.com", ratings: [{ skill: "Planning", score: null, skipped: true }] },
  ];
  const score = (submissions) => scoreEvent({
    skills: ["Planning"],
    participants,
    submissions,
    config: config({ credibilityEpsilon: 0.05, credibilityShrinkage: 5 }),
  }).participants.find((person) => person.email === "target@example.com").eventScore;
  assert.notEqual(score(base), score(withSkip));
});

test("a saved minimum sample labels the score provisional without changing it", () => {
  const result = scoreEvent({
    skills: ["Planning"],
    participants: [
      { email: "target@example.com", level: "Volunteer", committee: "Ops" },
      { email: "rater@example.com", level: "Volunteer", committee: "Ops" },
    ],
    submissions: [{
      raterEmail: "rater@example.com",
      targetEmail: "target@example.com",
      ratings: [{ skill: "Planning", score: 8, skipped: false }],
    }],
    config: config({ minimumRatings: 3 }),
  });
  const target = result.participants.find((person) => person.email === "target@example.com");
  assert.equal(target.eventScore, 8);
  assert.equal(target.status, "PROVISIONAL");
  assert.equal(target.reason, "below_minimum_ratings");
  assert.equal(combineOverall([target]).status, "PROVISIONAL");
});
