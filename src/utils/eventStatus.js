function computeEffectiveStatus(event, now = new Date()) {
  // event.status is stored manual status: DRAFT | PUBLISHED | CLOSED
  if (event.status === "DRAFT") return "DRAFT";
  if (event.status === "CLOSED" || event.closeAtActual) return "CLOSED";

  const eventStart = event.eventStartDate || event.eventDate;
  const eventEnd = event.eventEndDate || (event.eventStartDate ? null : event.eventDate);
  const endAt = eventEnd ? new Date(eventEnd) : null;

  if (endAt && now > endAt) return "CLOSED";
  if (!eventStart) return "PUBLISHED";

  const startAt = new Date(eventStart);
  if (now < startAt) return "SCHEDULED";
  if (endAt) return "OPEN";
  return "PUBLISHED";
}

function joinablePublishedFilter(now = new Date()) {
  return {
    status: "PUBLISHED",
    $nor: [
      { closeAtActual: { $exists: true, $ne: null } },
      { eventEndDate: { $lte: now } },
      { eventEndDate: null, eventStartDate: null, eventDate: { $lte: now } },
    ],
  };
}

module.exports = { computeEffectiveStatus, joinablePublishedFilter };
