const { cleanEmail } = require("./csvMatch");

const EMAIL_CHARACTERS_TO_STRIP = [
  "\u0009", "\u000A", "\u000B", "\u000C", "\u000D", "\u0020", "\u00A0", "\u1680",
  "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008", "\u2009", "\u200A",
  "\u200B", "\u200C", "\u200D", "\u2028", "\u2029", "\u202F", "\u205F", "\u3000", "\uFEFF",
];

function cleanedStoredEmail(field) {
  const hidden = EMAIL_CHARACTERS_TO_STRIP;
  return hidden.reduce(
    (input, character) => ({ $replaceAll: { input, find: character, replacement: "" } }),
    { $toLower: { $ifNull: [field, ""] } }
  );
}

function storedEmailEquals(field, email) {
  return { $eq: [cleanedStoredEmail(field), cleanEmail(email)] };
}

function sameStoredEmail(field, email) {
  return { $expr: storedEmailEquals(field, email) };
}

function pcreCharacter(character) {
  if (character === "\t") return "\\t";
  if (character === "\n") return "\\n";
  if (character === "\v") return "\\v";
  if (character === "\f") return "\\f";
  if (character === "\r") return "\\r";
  if (character === "\\") return "\\\\";
  if (character === "]") return "\\]";
  if (character === "^") return "\\^";
  if (character === "-") return "\\-";
  return character;
}

function emailMatchPattern(email) {
  const cleaned = cleanEmail(email);
  if (!cleaned) return null;
  const gap = `[${EMAIL_CHARACTERS_TO_STRIP.map(pcreCharacter).join("")}]*`;
  const body = Array.from(cleaned)
    .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(gap);
  const source = `^${gap}${body}${gap}$`;
  const pattern = new RegExp(source, "i");
  // JavaScript rewrites U+2028 and U+2029 in RegExp#source as \u escapes.
  // Atlas PCRE2 rejects \u, so Mongo receives this source with the characters themselves.
  Object.defineProperty(pattern, "source", { get: () => source });
  return pattern;
}

function emailMatchQuery(field, emails) {
  const patterns = [...new Set((Array.isArray(emails) ? emails : [emails]).map((email) => cleanEmail(email)).filter(Boolean))]
    .map((email) => emailMatchPattern(email))
    .filter(Boolean);
  if (patterns.length === 1) return { [field]: patterns[0] };
  if (patterns.length > 1) return { $or: patterns.map((pattern) => ({ [field]: pattern })) };
  return { [field]: /^$/ };
}

module.exports = {
  cleanedStoredEmail,
  storedEmailEquals,
  sameStoredEmail,
  emailMatchPattern,
  emailMatchQuery,
  EMAIL_CHARACTERS_TO_STRIP,
};
