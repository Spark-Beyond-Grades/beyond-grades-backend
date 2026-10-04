function createPublicProfileLimiter({ limit = 60, windowMs = 60_000 } = {}) {
  const hits = new Map();
  return {
    allow(key, now = Date.now()) {
      const recent = (hits.get(key) || []).filter((stamp) => now - stamp < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
  };
}

const sharedLimiter = createPublicProfileLimiter();

function publicProfileClientKey(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || String(req?.ip || "").trim() || "unknown";
}

function allowPublicProfileLookup(key, now) {
  return sharedLimiter.allow(key || "unknown", now);
}

module.exports = {
  createPublicProfileLimiter,
  publicProfileClientKey,
  allowPublicProfileLookup,
};
