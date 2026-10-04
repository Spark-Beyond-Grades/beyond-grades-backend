const test = require("node:test");
const assert = require("node:assert/strict");
const { createPublicProfileLimiter, publicProfileClientKey } = require("./publicProfileLimit");

test("public profile lookups slow down after the limit", () => {
  const limiter = createPublicProfileLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.allow("1.2.3.4", 1000), true);
  assert.equal(limiter.allow("1.2.3.4", 1100), true);
  assert.equal(limiter.allow("1.2.3.4", 1200), false);
  assert.equal(limiter.allow("5.6.7.8", 1200), true);
  assert.equal(limiter.allow("1.2.3.4", 2000), true);
});

test("public profile lookups use the forwarded client address", () => {
  assert.equal(publicProfileClientKey({ headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" }, ip: "10.0.0.1" }), "9.9.9.9");
  assert.equal(publicProfileClientKey({ ip: "10.0.0.8" }), "10.0.0.8");
  assert.equal(publicProfileClientKey({}), "unknown");
});
