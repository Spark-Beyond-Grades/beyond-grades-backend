function computeEffectiveStatus(event, now = new Date()) {
  // event.status is stored manual status: DRAFT | PUBLISHED | CLOSED
  if (event.status === "DRAFT") return "DRAFT";
  if (event.status === "CLOSED" || event.closeAtActual) return "CLOSED";

  const eventStart = event.eventStartDate || event.eventDate;
  const eventEnd = event.eventEndDate || event.eventDate;

  if (!eventStart) return "PUBLISHED";

  const startAt = new Date(eventStart);
  const endAt = eventEnd ? new Date(eventEnd) : null;

  if (now < startAt) return "SCHEDULED";
  if (endAt && now > endAt) return "CLOSED";
  if (endAt) return "OPEN";
  return "PUBLISHED";
}

module.exports = { computeEffectiveStatus };
