require("dotenv").config();
const mongoose = require("mongoose");
const Event = require("../src/models/Event");
const Participant = require("../src/models/Participant");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const event = await Event.findOne({ groupId: "demo-ui-review-2026" });
  await Participant.updateOne(
    { eventId: event._id, email: "demo.nisha@jklu.edu.in" },
    { $set: { name: "Nisha Kapoor", level: "Junior", committee: "Product" } },
    { upsert: true }
  );
  console.log(event._id.toString());
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => mongoose.disconnect());
