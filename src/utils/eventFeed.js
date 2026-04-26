const { computeEffectiveStatus } = require("./eventStatus");

function mapEventForStudentFeed(event, studentUniversityId) {
  const eventObj = event.toObject ? event.toObject() : event;
  const isUniversityEvent = eventObj.universityId?.toString() === studentUniversityId.toString();

  return {
    ...eventObj,
    effectiveStatus: computeEffectiveStatus(event),
    isUniversityEvent,
    feedScope: isUniversityEvent ? "UNIVERSITY" : "OUTSIDE",
  };
}

module.exports = { mapEventForStudentFeed };
