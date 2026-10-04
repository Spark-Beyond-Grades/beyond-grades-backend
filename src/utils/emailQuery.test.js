const test = require("node:test");
const assert = require("node:assert/strict");
const { BSON } = require("bson");
const { cleanEmail } = require("./csvMatch");
const { EMAIL_CHARACTERS_TO_STRIP, emailMatchPattern, sameStoredEmail } = require("./emailQuery");

test("sameStoredEmail ignores case and spaces in the stored email", () => {
  const query = sameStoredEmail("$email", "  Ad min@School.edu  ");
  assert.equal(query.$expr.$eq[1], "admin@school.edu");
  assert.equal(JSON.stringify(query).includes("$email"), true);
  assert.equal(JSON.stringify(query).includes("$replaceAll"), true);
});

test("a shallow email pattern matches case and every stripped space", () => {
  const pattern = emailMatchPattern("  Ada @Example.com  ");
  assert.equal(pattern.test("  Ada @Example.com  "), true);
  assert.equal(pattern.test("ADA@example.com"), true);
  assert.equal(pattern.test("other@example.com"), false);
  for (const character of EMAIL_CHARACTERS_TO_STRIP) {
    assert.equal(pattern.test(`ada${character}@example.com`), true, `U+${character.charCodeAt(0).toString(16)}`);
  }
  assert.equal(JSON.stringify({ email: pattern }).includes("$expr"), false);
  assert.equal(JSON.stringify({ email: pattern }).includes("$replaceAll"), false);
  assert.equal(pattern.source.includes("\\u"), false);
  assert.equal(BSON.serialize({ email: pattern }).includes(Buffer.from("\\u")), false);
});

test("stored email matching strips every space cleanEmail strips", () => {
  for (let code = 0; code <= 0xFEFF; code += 1) {
    const character = String.fromCharCode(code);
    if (cleanEmail(`a${character}b@x.com`) !== "ab@x.com") continue;
    assert.equal(EMAIL_CHARACTERS_TO_STRIP.includes(character), true, `missing U+${code.toString(16)}`);
  }
});
