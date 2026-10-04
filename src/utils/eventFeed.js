const { computeEffectiveStatus } = require("./eventStatus");
const { canonicalEventStructure } = require("./csvMatch");

const HIDDEN_FROM_STUDENTS = ["scoringConfig", "frozenScores", "frozenScoreHistory", "createdByEmail", "groupId"];

function studentVisibleEvent(event) {
  const eventObj = { ...(event.toObject ? event.toObject() : event) };
  for (const field of HIDDEN_FROM_STUDENTS) delete eventObj[field];
  return { ...eventObj, ...canonicalEventStructure(eventObj) };
}

function mapEventForStudentFeed(event, studentUniversityId) {
  const eventObj = studentVisibleEvent(event);
  const isUniversityEvent = eventObj.universityId?.toString() === studentUniversityId.toString();

  return {
    ...eventObj,
    eventDate: eventObj.eventStartDate || eventObj.eventDate, // Support new and old date fields
    effectiveStatus: computeEffectiveStatus(event),
    isUniversityEvent,
    feedScope: isUniversityEvent ? "UNIVERSITY" : "OUTSIDE",
  };
}

module.exports = { mapEventForStudentFeed, studentVisibleEvent };
