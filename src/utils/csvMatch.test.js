const test = require("node:test");
const assert = require("node:assert/strict");
const { canonicalChoice, cell, isCsvUpload, uniqueSkills, canonicalEventStructure, unmatchedAllowedLevel } = require("./csvMatch");

test("committee and level matching ignores case and extra spaces", () => {
  assert.equal(canonicalChoice("  hospitality ", ["Hospitality", "Tech"]), "Hospitality");
  assert.equal(canonicalChoice("HEAD", ["Head"]), "Head");
  assert.equal(canonicalChoice("Hospitality\u00A0", ["Hospitality"]), "Hospitality");
  assert.equal(canonicalChoice("Hos\u200Bpitality", ["Hospitality"]), "Hospitality");
  assert.equal(canonicalChoice("Missing", ["Hospitality"]), "");
});

test("csv uploads accept a .csv file even when the browser sends a generic type", () => {
  assert.equal(isCsvUpload({ originalname: "Roster.csv", mimetype: "application/octet-stream" }), true);
  assert.equal(isCsvUpload({ originalname: "roster.csv", mimetype: "text/plain" }), true);
  assert.equal(isCsvUpload({ originalname: "roster.csv", mimetype: "text/csv" }), true);
  assert.equal(isCsvUpload({ originalname: "roster.png", mimetype: "text/csv" }), false);
  assert.equal(isCsvUpload({ originalname: "roster.csv", mimetype: "application/pdf" }), false);
});

test("repeated skill names keep the first spelling", () => {
  assert.deepEqual(uniqueSkills(["Planning", " planning ", "Planning", ""]), ["Planning"]);
});

test("repeated levels and committees keep the first spelling", () => {
  assert.deepEqual(canonicalEventStructure({
    levels: ["Head", " head "],
    committees: [
      { name: "Ops", allowedLevels: ["head"] },
      { name: " ops ", allowedLevels: ["Head", "Volunteer"] },
    ],
    skills: ["Planning", "planning"],
  }), {
    levels: ["Head"],
    committees: [{ name: "Ops", allowedLevels: ["Head"] }],
    skills: ["Planning"],
  });
  assert.equal(unmatchedAllowedLevel([{ allowedLevels: ["Guest"] }], ["Head"]), "Guest");
  assert.equal(unmatchedAllowedLevel([{ allowedLevels: [" head "] }], ["Head"]), "");
});

test("csv cells accept renamed headers", () => {
  assert.equal(cell({ "Committee Name": "Tech" }, ["committee", "committee name"]), "Tech");
  assert.equal(cell({ "\uFEFFLevel": "Core" }, ["level"]), "Core");
});
