const test = require("node:test");
const assert = require("node:assert/strict");
const { createShareToken, hashShareToken } = require("./shareToken");

test("createShareToken returns a non-guessable token and its matching hash", () => {
  const first = createShareToken();
  const second = createShareToken();

  assert.notEqual(first.token, second.token);
  assert.ok(first.token.length >= 40);
  assert.equal(first.hash, hashShareToken(first.token));
  assert.notEqual(first.hash, first.token);
});
