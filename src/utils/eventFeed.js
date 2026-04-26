const { computeEffectiveStatus } = require("./eventStatus");

function mapEventForStudentFeed(event, studentUniversityId) {
  const eventObj = event.toObject ? event.toObject() : event;
  const isUniversityEvent = eventObj.universityId?.toString() === studentUniversityId.toString();

  return {
    ...eventObj,
    eventDate: eventObj.eventStartDate || eventObj.eventDate, // Support new and old date fields
    effectiveStatus: computeEffectiveStatus(event),
    isUniversityEvent,
    feedScope: isUniversityEvent ? "UNIVERSITY" : "OUTSIDE",
  };
}

module.exports = { mapEventForStudentFeed };
