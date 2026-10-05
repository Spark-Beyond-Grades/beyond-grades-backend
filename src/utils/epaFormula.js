const { normalizeLabel, cleanEmail, uniqueSkills } = require("./csvMatch");

const FORMULA_VERSION = "epa-reindexed-v1";

const DEFAULT_SCORING_VALUES = {
  scaleMin: 1,
  scaleMax: 10,
  levelInfluence: 0,
  committeeWeightSame: 1,
  committeeWeightTop: 1,
  committeeWeightOther: 1,
  credibilityEpsilon: 0.05,
  credibilityShrinkage: 5,
  confidencePrior: 5,
  evenMedianRule: "average",
  allowSelfRatings: false,
  blankSkillPolicy: "ignoreSkill",
  unscoredSkillPolicy: "exclude",
  crossEventRule: "confidence",
  applyRelevanceToSkillWeights: false,
  contributesToScoring: true,
};

const REQUIRED_FIELDS = [
  "scaleMin",
  "scaleMax",
  "levelInfluence",
  "committeeWeightSame",
  "committeeWeightTop",
  "committeeWeightOther",
  "credibilityEpsilon",
  "credibilityShrinkage",
  "confidencePrior",
  "evenMedianRule",
  "allowSelfRatings",
  "blankSkillPolicy",
  "unscoredSkillPolicy",
  "crossEventRule",
  "applyRelevanceToSkillWeights",
  "contributesToScoring",
];

function isFiniteNumber(value) {
  if (value === "" || value == null || typeof value === "boolean") return false;
  return Number.isFinite(Number(value));
}

function missingSettings(config, structure = {}) {
  const missing = [];
  if (!config || typeof config !== "object") return ["scoringConfig"];

  for (const field of REQUIRED_FIELDS) {
    if (config[field] === undefined || config[field] === null || config[field] === "") missing.push(field);
  }

  const numericFields = [
    "scaleMin",
    "scaleMax",
    "levelInfluence",
    "committeeWeightSame",
    "committeeWeightTop",
    "committeeWeightOther",
    "credibilityEpsilon",
    "credibilityShrinkage",
    "confidencePrior",
  ];
  for (const field of numericFields) {
    if (config[field] !== undefined && config[field] !== null && config[field] !== "" && !isFiniteNumber(config[field])) {
      missing.push(field);
    }
  }

  if (isFiniteNumber(config.scaleMin) && isFiniteNumber(config.scaleMax) && Number(config.scaleMin) >= Number(config.scaleMax)) {
    missing.push("scaleRange");
  }
  if (isFiniteNumber(config.credibilityEpsilon) && Number(config.credibilityEpsilon) <= 0) missing.push("credibilityEpsilon");
  for (const field of ["committeeWeightSame", "committeeWeightTop", "committeeWeightOther", "credibilityShrinkage", "confidencePrior"]) {
    if (isFiniteNumber(config[field]) && Number(config[field]) < 0) missing.push(`nonNegative:${field}`);
  }
  if (config.evenMedianRule && !["average", "lower", "higher"].includes(config.evenMedianRule)) missing.push("evenMedianRule");
  if (config.blankSkillPolicy && !["ignoreSkill", "ignorePair"].includes(config.blankSkillPolicy)) missing.push("blankSkillPolicy");
  if (config.unscoredSkillPolicy && !["exclude", "block"].includes(config.unscoredSkillPolicy)) missing.push("unscoredSkillPolicy");
  if (config.crossEventRule && !["none", "equal", "confidence"].includes(config.crossEventRule)) missing.push("crossEventRule");
  if (config.allowSelfRatings !== undefined && typeof config.allowSelfRatings !== "boolean") missing.push("allowSelfRatings");
  if (config.applyRelevanceToSkillWeights !== undefined && typeof config.applyRelevanceToSkillWeights !== "boolean") missing.push("applyRelevanceToSkillWeights");
  if (config.contributesToScoring !== undefined && typeof config.contributesToScoring !== "boolean") missing.push("contributesToScoring");
  if (config.minimumRatings !== undefined && config.minimumRatings !== null && config.minimumRatings !== "" && (!isFiniteNumber(config.minimumRatings) || Number(config.minimumRatings) < 0)) {
    missing.push("minimumRatings");
  }

  const levels = structure.levels || [];
  const committees = structure.committees || [];
  const skills = structure.skills || [];
  const ranks = config.levelRanks || {};
  for (const level of levels) {
    if (!isFiniteNumber(ranks[level])) missing.push(`levelRank:${level}`);
  }
  const relevance = config.relevance || {};
  for (const committee of committees) {
    for (const skill of skills) {
      const relevanceValue = relevance?.[committee]?.[skill];
      if (!isFiniteNumber(relevanceValue)) missing.push(`relevance:${committee}:${skill}`);
      else if (Number(relevanceValue) < 0) missing.push(`nonNegative:relevance:${committee}:${skill}`);
    }
  }
  if (config.applyRelevanceToSkillWeights === false) {
    const weights = config.skillWeights || {};
    for (const skill of skills) {
      if (!isFiniteNumber(weights[skill])) missing.push(`skillWeight:${skill}`);
      else if (Number(weights[skill]) < 0) missing.push(`nonNegative:skillWeight:${skill}`);
    }
  }

  return [...new Set(missing)];
}

function median(values, rule) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  if (rule === "lower") return sorted[mid - 1];
  if (rule === "higher") return sorted[mid];
  if (rule === "average") return (sorted[mid - 1] + sorted[mid]) / 2;
  return null;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function displayScore(unit, scaleMin, scaleMax) {
  return scaleMin + (scaleMax - scaleMin) * unit;
}

function snapToScale(value, scaleMin, scaleMax) {
  const tolerance = 1e-4;
  if (value < scaleMin && value >= scaleMin - tolerance) return scaleMin;
  if (value > scaleMax && value <= scaleMax + tolerance) return scaleMax;
  return value;
}

function rawScore(rating, scaleMin, scaleMax) {
  if (!rating || rating.skipped) return null;
  const value = rating.score;
  if (value === null || value === undefined || value === false || value === true) return null;
  const text = typeof value === "string" ? value.trim() : value;
  if (text === "") return null;
  const raw = Number(text);
  if (!Number.isFinite(raw)) return null;
  const snapped = snapToScale(raw, scaleMin, scaleMax);
  if (snapped < scaleMin || snapped > scaleMax) return null;
  return snapped;
}

function auditStatus(scored, { closed = false } = {}) {
  if (!scored || typeof scored !== "object") return "not_configured";
  if (scored.eligible === false) return "not_eligible";
  if (scored.configured === false) return "not_configured";
  if (closed && scored.formulaVersion !== FORMULA_VERSION) return "recalculation_required";
  if (closed) return "final";
  if ((scored.participants || []).some((person) => person.status === "PROVISIONAL")) return "provisional";
  return "collecting";
}

function reviewCoverage(participants, submissions, allowSelf, skills = []) {
  const emails = new Set(participants.map((person) => cleanEmail(person.email)).filter(Boolean));
  const skillNames = new Set(skills);
  if (!skillNames.size) return { submittedReviews: 0, expectedReviews: null, countable: false };
  const expectedReviews = allowSelf === true || allowSelf === false
    ? emails.size * (allowSelf ? emails.size : Math.max(emails.size - 1, 0))
    : null;
  const seen = new Set();
  for (const submission of submissions) {
    const rater = cleanEmail(submission.raterEmail);
    const target = cleanEmail(submission.targetEmail);
    if (!emails.has(rater) || !emails.has(target)) continue;
    if (allowSelf !== true && rater === target) continue;
    const mentionsCurrentSkill = (submission.ratings || []).some((rating) => skillNames.has(canonicalLabel(rating?.skill, skills, new Map())));
    if (!mentionsCurrentSkill) continue;
    seen.add(`${rater}\0${target}`);
  }
  return { submittedReviews: seen.size, expectedReviews, countable: true };
}

function uniqueParticipants(participants) {
  const byEmail = new Map();
  for (const person of participants || []) {
    const email = cleanEmail(person.email);
    if (!email) continue;
    const next = { ...person, email };
    const current = byEmail.get(email);
    if (!current) {
      byEmail.set(email, next);
      continue;
    }
    const complete = (row) => String(row.level || "").trim() && String(row.committee || "").trim();
    const preferred = !complete(current) && complete(next) ? next : current;
    const other = preferred === next ? current : next;
    const merged = { ...other, ...preferred, email };
    for (const field of ["name", "rollNumber", "position", "photoUrl", "bio", "level", "committee"]) {
      if (!String(merged[field] || "").trim() && String(other[field] || "").trim()) merged[field] = other[field];
    }
    byEmail.set(email, merged);
  }
  return [...byEmail.values()];
}

function canonicalLabel(value, keys, seen) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const normalized = normalizeLabel(trimmed);
  const preferred = (keys || []).find((key) => normalizeLabel(key) === normalized);
  if (preferred) return preferred;
  if (!seen.has(normalized)) seen.set(normalized, trimmed);
  return seen.get(normalized);
}

function usableNumber(value) {
  if (value === "" || value === null || value === undefined || value === false || value === true) return false;
  return Number.isFinite(Number(value));
}

function preferredValue(matches) {
  const filled = matches.find(([, value]) => usableNumber(value));
  return filled || matches[0];
}

function columnForSkills(source, skills) {
  const entries = Object.entries(source || {});
  const aligned = {};
  for (const skill of skills) {
    const matches = entries.filter(([key]) => normalizeLabel(key) === normalizeLabel(skill));
    const chosen = preferredValue(matches);
    if (chosen) aligned[skill] = chosen[1];
  }
  return aligned;
}

function collapseLabelMap(source) {
  const groups = new Map();
  for (const [label, value] of Object.entries(source || {})) {
    const key = normalizeLabel(label);
    if (!key) continue;
    const group = groups.get(key) || { name: String(label).trim() || label, values: [] };
    group.values.push([label, value]);
    groups.set(key, group);
  }
  const aligned = {};
  for (const group of groups.values()) {
    const chosen = preferredValue(group.values);
    if (chosen) aligned[group.name] = chosen[1];
  }
  return aligned;
}

function collapseRelevance(relevance, skills) {
  const groups = new Map();
  for (const [committee, row] of Object.entries(relevance || {})) {
    const key = normalizeLabel(committee);
    if (!key) continue;
    const group = groups.get(key) || { name: String(committee).trim() || committee, rows: [] };
    group.rows.push(row || {});
    groups.set(key, group);
  }
  const aligned = {};
  for (const group of groups.values()) {
    const combined = {};
    for (const row of group.rows) {
      for (const [skill, value] of Object.entries(row)) {
        if (combined[skill] === undefined || (!usableNumber(combined[skill]) && usableNumber(value))) {
          combined[skill] = value;
        }
      }
    }
    aligned[group.name] = columnForSkills(combined, skills);
  }
  return aligned;
}

function alignScoringConfigToStructure(config, structure = {}) {
  if (!config || typeof config !== "object") return config;
  const levels = structure.levels || [];
  const skills = structure.skills || [];
  const committees = (structure.committees || []).map((committee) => (
    typeof committee === "string" ? committee : committee?.name
  )).filter(Boolean);
  const relevanceSource = config.relevance || {};
  const relevance = {};
  for (const committee of committees) {
    const rows = Object.entries(relevanceSource)
      .filter(([key]) => normalizeLabel(key) === normalizeLabel(committee))
      .map(([, row]) => row || {});
    const combined = {};
    for (const row of rows) {
      for (const [skill, value] of Object.entries(row)) {
        if (combined[skill] === undefined || (!usableNumber(combined[skill]) && usableNumber(value))) {
          combined[skill] = value;
        }
      }
    }
    relevance[committee] = columnForSkills(combined, skills);
  }
  return {
    ...config,
    levelRanks: levels.length ? columnForSkills(config.levelRanks, levels) : (config.levelRanks || {}),
    skillWeights: skills.length ? columnForSkills(config.skillWeights, skills) : (config.skillWeights || {}),
    relevance: committees.length ? relevance : (config.relevance || {}),
  };
}

function alignSkillSettings(config, skills) {
  if (!config || typeof config !== "object") return config;
  return {
    ...config,
    levelRanks: collapseLabelMap(config.levelRanks),
    skillWeights: columnForSkills(config.skillWeights, skills),
    relevance: collapseRelevance(config.relevance, skills),
  };
}

function alignParticipants(participants, config) {
  const rankKeys = Object.keys(config?.levelRanks || {});
  const committeeKeys = Object.keys(config?.relevance || {});
  const levels = new Map();
  const committees = new Map();
  return participants.map((person) => ({
    ...person,
    level: canonicalLabel(person.level, rankKeys, levels),
    committee: canonicalLabel(person.committee, committeeKeys, committees),
  }));
}

function scoreEvent({ skills: listedSkills = [], participants: rawParticipants = [], submissions = [], config }) {
  const skills = uniqueSkills(listedSkills);
  const initialParticipants = uniqueParticipants(rawParticipants);
  const levels = [...new Set(initialParticipants.map((person) => person.level).filter(Boolean))];
  const committees = [...new Set(initialParticipants.map((person) => person.committee).filter(Boolean))];
  config = {
    ...DEFAULT_SCORING_VALUES,
    ...(config || {}),
    levelRanks: { ...Object.fromEntries(levels.map((level, index) => [level, index + 1])), ...(config?.levelRanks || {}) },
    skillWeights: { ...Object.fromEntries(skills.map((skill) => [skill, 1])), ...(config?.skillWeights || {}) },
    relevance: { ...Object.fromEntries(committees.map((committee) => [committee, Object.fromEntries(skills.map((skill) => [skill, 1]))])), ...(config?.relevance || {}) },
  };
  config = alignSkillSettings(config, skills);
  const participants = alignParticipants(initialParticipants, config);
  const coverage = reviewCoverage(participants, submissions, config?.allowSelfRatings, skills);
  const structure = {
    levels: [...new Set(participants.map((person) => person.level).filter(Boolean))],
    committees: [...new Set(participants.map((person) => person.committee).filter(Boolean))],
    skills,
  };
  const missing = missingSettings(config, {
    levels: [...new Set([...(structure.levels || []), ...Object.keys(config?.levelRanks || {})])].filter((level) => structure.levels.includes(level)),
    committees: structure.committees,
    skills,
  });
  const roleGaps = [];
  for (const person of participants) {
    if (!String(person.level || "").trim()) roleGaps.push("levelRank");
    if (!String(person.committee || "").trim()) roleGaps.push("committee");
  }
  const structuralMissing = [...missingSettings(config, structure), ...new Set(roleGaps)];
  if (config?.contributesToScoring === false && structuralMissing.length) {
    return {
      formulaVersion: FORMULA_VERSION,
      configured: true,
      eligible: false,
      missing: [],
      coverage,
      participants: participants.map((person) => ({
        email: cleanEmail(person.email),
        eventScore: null,
        confidence: null,
        status: "NOT_ELIGIBLE",
        reason: "not_eligible",
        skills: [],
      })),
    };
  }
  if (structuralMissing.length) {
    return {
      formulaVersion: FORMULA_VERSION,
      configured: false,
      eligible: null,
      missing: structuralMissing,
      coverage,
      participants: participants.map((person) => ({
        email: person.email,
        eventScore: null,
        confidence: null,
        status: "NOT_CONFIGURED",
        reason: "missing_settings",
        skills: [],
      })),
    };
  }

  const scaleMin = Number(config.scaleMin);
  const scaleMax = Number(config.scaleMax);
  const people = participants.map((person) => ({
    email: cleanEmail(person.email),
    level: person.level,
    committee: person.committee,
  }));
  const indexByEmail = new Map(people.map((person, index) => [person.email, index]));

  const pairSkills = new Map();
  for (const submission of submissions) {
    const rater = cleanEmail(submission.raterEmail);
    const target = cleanEmail(submission.targetEmail);
    if (!indexByEmail.has(rater) || !indexByEmail.has(target)) continue;
    if (!config.allowSelfRatings && rater === target) continue;
    const bySkill = pairSkills.get(`${rater}\0${target}`) || new Map();
    for (const rating of submission.ratings || []) {
      const skill = canonicalLabel(rating.skill, skills, new Map());
      if (!skills.includes(skill)) continue;
      bySkill.set(skill, rating);
    }
    if (bySkill.size) pairSkills.set(`${rater}\0${target}`, bySkill);
  }

  const reviewMask = new Set();
  const cell = new Map();
  for (const [pairKey, bySkill] of pairSkills) {
    const missingSkill = skills.some((skill) => rawScore(bySkill.get(skill), scaleMin, scaleMax) == null);
    reviewMask.add(pairKey);
    if (config.blankSkillPolicy === "ignorePair" && missingSkill) continue;
    for (const skill of skills) {
      const raw = rawScore(bySkill.get(skill), scaleMin, scaleMax);
      if (raw == null) continue;
      cell.set(`${pairKey}\0${skill}`, (raw - scaleMin) / (scaleMax - scaleMin));
    }
  }

  const received = (rateeIndex, skill) => {
    const values = [];
    people.forEach((rater, raterIndex) => {
      const value = cell.get(`${rater.email}\0${people[rateeIndex].email}\0${skill}`);
      if (value !== undefined) values.push({ raterIndex, value });
    });
    return values;
  };

  const consensus = people.map(() => ({}));
  skills.forEach((skill) => {
    people.forEach((_, rateeIndex) => {
      consensus[rateeIndex][skill] = median(received(rateeIndex, skill).map((item) => item.value), config.evenMedianRule);
    });
  });

  const bias = people.map(() => ({}));
  skills.forEach((skill) => {
    people.forEach((rater, raterIndex) => {
      const deviations = [];
      people.forEach((ratee, rateeIndex) => {
        const value = cell.get(`${rater.email}\0${ratee.email}\0${skill}`);
        const center = consensus[rateeIndex][skill];
        if (value !== undefined && center !== null) deviations.push(value - center);
      });
      bias[raterIndex][skill] = median(deviations, config.evenMedianRule);
    });
  });

  const corrected = new Map();
  for (const [key, value] of cell) {
    const [raterEmail, , skill] = key.split("\0");
    const raterIndex = indexByEmail.get(raterEmail);
    const shift = bias[raterIndex][skill];
    corrected.set(key, shift === null ? null : clamp(value - shift, 0, 1));
  }

  const ranks = people.map((person) => Number(config.levelRanks[person.level]));
  const topRank = Math.max(...ranks);
  const givenCount = people.map((rater) => people.filter((ratee) => reviewMask.has(`${rater.email}\0${ratee.email}`)).length);

  const credibility = people.map(() => ({}));
  skills.forEach((skill) => {
    people.forEach((rater, raterIndex) => {
      const deviations = [];
      people.forEach((ratee, rateeIndex) => {
        const value = corrected.get(`${rater.email}\0${ratee.email}\0${skill}`);
        const center = consensus[rateeIndex][skill];
        if (value !== null && value !== undefined && center !== null) deviations.push(Math.abs(value - center));
      });
      const deviation = median(deviations, config.evenMedianRule);
      if (deviation === null) {
        credibility[raterIndex][skill] = null;
        return;
      }
      const rawCredibility = 1 / (Number(config.credibilityEpsilon) + deviation);
      const volume = givenCount[raterIndex];
      const shrinkage = Number(config.credibilityShrinkage);
      credibility[raterIndex][skill] = 1 + (volume / (volume + shrinkage)) * (rawCredibility - 1);
    });
  });

  const participantResults = people.map((person, rateeIndex) => {
    const skillResults = skills.map((skill) => {
      const observations = received(rateeIndex, skill);
      if (!observations.length) {
        return { skill, score: null, confidence: null, ratingCount: 0, reason: "no_ratings" };
      }
      let weightSum = 0;
      let weightedScore = 0;
      let squaredWeight = 0;
      for (const observation of observations) {
        const rater = people[observation.raterIndex];
        const levelWeight = 1 + Number(config.levelInfluence) * Math.tanh(ranks[observation.raterIndex] - ranks[rateeIndex]);
        const sameCommittee = rater.committee === person.committee;
        const committeeWeight = sameCommittee
          ? Number(config.committeeWeightSame)
          : ranks[observation.raterIndex] === topRank
            ? Number(config.committeeWeightTop)
            : Number(config.committeeWeightOther);
        const relevance = Number(config.relevance?.[person.committee]?.[skill]);
        const cred = credibility[observation.raterIndex][skill];
        if (!Number.isFinite(relevance)) continue;
        const correctedValue = corrected.get(`${rater.email}\0${person.email}\0${skill}`);
        if (cred === null || correctedValue === null || correctedValue === undefined) continue;
        const weight = levelWeight * committeeWeight * relevance * cred;
        weightSum += weight;
        weightedScore += weight * correctedValue;
        squaredWeight += weight * weight;
      }
      if (weightSum === 0 || squaredWeight === 0) {
        return { skill, score: null, confidence: null, ratingCount: observations.length, reason: "zero_weight" };
      }
      const unit = weightedScore / weightSum;
      const effectiveSample = (weightSum * weightSum) / squaredWeight;
      const confidence = effectiveSample / (effectiveSample + Number(config.confidencePrior));
      return {
        skill,
        score: displayScore(unit, scaleMin, scaleMax),
        unit,
        confidence,
        ratingCount: observations.length,
        reason: null,
      };
    });

    const scored = skillResults.filter((skill) => skill.score !== null);
    if (config.unscoredSkillPolicy === "block" && scored.length !== skills.length) {
      return {
        email: person.email,
        eventScore: null,
        confidence: null,
        status: "NO_DATA",
        reason: "unscored_skill",
        scaleMin,
        scaleMax,
        skills: skillResults,
      };
    }
    if (!scored.length) {
      return {
        email: person.email,
        eventScore: null,
        confidence: null,
        status: "NO_DATA",
        reason: "no_ratings",
        scaleMin,
        scaleMax,
        skills: skillResults,
      };
    }
    const weights = scored.map((skill) => (
      config.applyRelevanceToSkillWeights
        ? Number(config.relevance[person.committee][skill.skill])
        : Number(config.skillWeights[skill.skill])
    ));
    const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
    if (weightTotal === 0) {
      return {
        email: person.email,
        eventScore: null,
        confidence: null,
        status: "NO_DATA",
        reason: "zero_skill_weight",
        scaleMin,
        scaleMax,
        skills: skillResults,
      };
    }
    const eventUnit = scored.reduce((sum, skill, index) => sum + weights[index] * skill.unit, 0) / weightTotal;
    const confidence = scored.reduce((sum, skill, index) => sum + weights[index] * (skill.confidence || 0), 0) / weightTotal;
    const reviewCount = people.filter((rater) => reviewMask.has(`${rater.email}\0${person.email}`)).length;
    const minimumRatings = config.minimumRatings === undefined || config.minimumRatings === null || config.minimumRatings === ""
      ? null
      : Number(config.minimumRatings);
    const provisional = Number.isFinite(minimumRatings) && reviewCount < minimumRatings;
    return {
      email: person.email,
      eventScore: displayScore(eventUnit, scaleMin, scaleMax),
      confidence,
      reviewCount,
      status: provisional ? "PROVISIONAL" : "READY",
      reason: provisional ? "below_minimum_ratings" : null,
      scaleMin,
      scaleMax,
      crossEventRule: "confidence",
      skills: skillResults,
    };
  });

  const scoredEvent = {
    formulaVersion: FORMULA_VERSION,
    configured: true,
    eligible: true,
    missing: [],
    coverage,
    scaleMin,
    scaleMax,
    crossEventRule: "confidence",
    participants: participantResults,
  };
  if (config?.contributesToScoring !== false) return scoredEvent;
  return {
    ...scoredEvent,
    eligible: false,
    participants: participantResults.map((person) => ({
      ...person,
      eventScore: null,
      confidence: null,
      status: "NOT_ELIGIBLE",
      reason: "not_eligible",
    })),
  };
}

function combineOverall(results) {
  if (!results.length) {
    return { score: null, confidence: null, status: "NO_DATA", reason: "no_events", eventCount: 0, rule: null, scaleMin: null, scaleMax: null };
  }
  const contributing = results.filter((result) =>
    result.status !== "NOT_CONFIGURED" &&
    result.status !== "NOT_ELIGIBLE"
  );
  const rules = ["confidence"];
  if (!contributing.length) {
    return {
      score: null,
      confidence: null,
      status: "NO_DATA",
      reason: "no_event_scores",
      eventCount: 0,
      rule: "confidence",
      scaleMin: null,
      scaleMax: null,
    };
  }
  if (rules.length !== 1) {
    return { score: null, confidence: null, status: "NOT_CONFIGURED", reason: "mixed_cross_event_rules", eventCount: 0, rule: null, scaleMin: null, scaleMax: null };
  }
  const rule = rules[0];
  const ready = contributing.filter((result) => (result.status === "READY" || result.status === "PROVISIONAL") && Number.isFinite(result.eventScore));
  if (!ready.length) {
    return { score: null, confidence: null, status: "NO_DATA", reason: "no_event_scores", eventCount: 0, rule, scaleMin: null, scaleMax: null };
  }
  const scales = new Set(ready.map((result) => `${result.scaleMin}:${result.scaleMax}`));
  if (scales.size !== 1) {
    return { score: null, confidence: null, status: "NOT_CONFIGURED", reason: "mixed_scales", eventCount: ready.length, rule, scaleMin: null, scaleMax: null };
  }
  const provisional = ready.some((result) => result.status === "PROVISIONAL");
  const overallStatus = provisional ? "PROVISIONAL" : "READY";
  const overallReason = provisional ? "below_minimum_ratings" : null;
  if (rule === "confidence") {
    const weight = ready.reduce((sum, result) => sum + (Number(result.confidence) || 0), 0);
    if (weight === 0) {
      return { score: null, confidence: null, status: "NO_DATA", reason: "zero_confidence_weight", eventCount: ready.length, rule, scaleMin: ready[0].scaleMin, scaleMax: ready[0].scaleMax };
    }
    return {
      score: ready.reduce((sum, result) => sum + result.eventScore * (Number(result.confidence) || 0), 0) / weight,
      confidence: weight / ready.length,
      status: overallStatus,
      reason: overallReason,
      eventCount: ready.length,
      rule,
      scaleMin: ready[0].scaleMin,
      scaleMax: ready[0].scaleMax,
    };
  }
  return {
    score: ready.reduce((sum, result) => sum + result.eventScore, 0) / ready.length,
    confidence: ready.reduce((sum, result) => sum + (Number(result.confidence) || 0), 0) / ready.length,
    status: overallStatus,
    reason: overallReason,
    eventCount: ready.length,
    rule,
    scaleMin: ready[0].scaleMin,
    scaleMax: ready[0].scaleMax,
  };
}

module.exports = {
  FORMULA_VERSION,
  missingSettings,
  median,
  auditStatus,
  reviewCoverage,
  uniqueParticipants,
  snapToScale,
  alignScoringConfigToStructure,
  scoreEvent,
  combineOverall,
};
