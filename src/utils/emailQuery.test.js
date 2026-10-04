const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanEmail } = require("./csvMatch");
const { EMAIL_CHARACTERS_TO_STRIP, sameStoredEmail } = require("./emailQuery");

test("sameStoredEmail ignores case and spaces in the stored email", () => {
  const query = sameStoredEmail("$email", "  Ad min@School.edu  ");
  assert.equal(query.$expr.$eq[1], "admin@school.edu");
  assert.equal(JSON.stringify(query).includes("$email"), true);
  assert.equal(JSON.stringify(query).includes("$replaceAll"), true);
});

test("stored email matching strips every space cleanEmail strips", () => {
  for (let code = 0; code <= 0xFEFF; code += 1) {
    const character = String.fromCharCode(code);
    if (cleanEmail(`a${character}b@x.com`) !== "ab@x.com") continue;
    assert.equal(EMAIL_CHARACTERS_TO_STRIP.includes(character), true, `missing U+${code.toString(16)}`);
  }
});
