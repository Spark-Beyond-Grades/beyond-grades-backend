function computeEffectiveStatus(event, now = new Date()) {
  // event.status is stored manual status: DRAFT | PUBLISHED | CLOSED
  if (event.status === "DRAFT") return "DRAFT";
  if (event.status === "CLOSED" || event.closeAtActual) return "CLOSED";

  // published but missing dates (should be prevented by publish validation later)
  if (!event.openAt || !event.closeAtTentative) return "SCHEDULED";

  const openAt = new Date(event.openAt);
  const closeAt = new Date(event.closeAtTentative);

  if (now < openAt) return "SCHEDULED";
  if (now >= openAt && now <= closeAt) return "OPEN";
  return "CLOSED";
}

module.exports = { computeEffectiveStatus };
