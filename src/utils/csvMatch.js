function normalizeLabel(value) {
  return String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function cell(row, names) {
  const wanted = new Set(names.map((name) => normalizeLabel(name)));
  for (const [key, value] of Object.entries(row || {})) {
    if (wanted.has(normalizeLabel(key))) return value == null ? "" : String(value);
  }
  return "";
}

function cleanEmail(value) {
  return String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function uniqueLabels(values) {
  const seen = new Set();
  const ordered = [];
  for (const value of values || []) {
    const trimmed = String(value || "").trim();
    if (!trimmed) continue;
    const key = normalizeLabel(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    ordered.push(trimmed);
  }
  return ordered;
}

function uniqueSkills(skills) {
  return uniqueLabels(skills);
}

function canonicalEventStructure(event) {
  const levels = Array.isArray(event?.levels) ? uniqueLabels(event.levels) : null;
  const structure = {};
  if (levels) structure.levels = levels;
  if (Array.isArray(event?.skills)) structure.skills = uniqueLabels(event.skills);
  if (!Array.isArray(event?.committees)) return structure;

  const committees = [];
  for (const committee of event.committees) {
    const name = String(committee?.name || "").trim();
    const key = normalizeLabel(name);
    if (!key) continue;
    const allowedLevels = [];
    for (const level of uniqueLabels(committee?.allowedLevels)) {
      const choice = levels && levels.length ? canonicalChoice(level, levels) : level;
      if (choice && !allowedLevels.includes(choice)) allowedLevels.push(choice);
    }
    const existing = committees.find((item) => normalizeLabel(item.name) === key);
    if (existing) {
      existing.allowedLevels = uniqueLabels([...existing.allowedLevels, ...allowedLevels]);
      continue;
    }
    committees.push({ name, allowedLevels });
  }
  structure.committees = committees;
  return structure;
}

function unmatchedAllowedLevel(committees, levels) {
  const known = uniqueLabels(levels);
  if (!known.length) return "";
  for (const committee of committees || []) {
    for (const level of committee?.allowedLevels || []) {
      const trimmed = String(level || "").trim();
      if (trimmed && !canonicalChoice(trimmed, known)) return trimmed;
    }
  }
  return "";
}

function canonicalChoice(value, options) {
  const normalized = normalizeLabel(value);
  if (!normalized) return "";
  return options.find((option) => normalizeLabel(option) === normalized) || "";
}

function isCsvUpload(file) {
  const name = String(file?.originalname || "").toLowerCase();
  const type = String(file?.mimetype || "").toLowerCase();
  if (!name.endsWith(".csv")) return false;
  return ["text/csv", "application/vnd.ms-excel", "application/csv", "text/plain", "application/octet-stream", ""].includes(type);
}

module.exports = {
  normalizeLabel,
  cell,
  canonicalChoice,
  cleanEmail,
  isCsvUpload,
  uniqueLabels,
  uniqueSkills,
  canonicalEventStructure,
  unmatchedAllowedLevel,
};
