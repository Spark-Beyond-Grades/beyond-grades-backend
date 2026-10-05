require("dotenv").config();
const mongoose = require("mongoose");
const Student = require("../src/models/Student");
const University = require("../src/models/University");
const Event = require("../src/models/Event");
const Participant = require("../src/models/Participant");
const FeedbackSubmission = require("../src/models/FeedbackSubmission");
const Startup = require("../src/models/Startup");
const Job = require("../src/models/Job");
const Certificate = require("../src/models/Certificate");
const { scoreEvent } = require("../src/utils/epaFormula");

const email = (process.argv[2] || "indrajitroy@jklu.edu.in").trim().toLowerCase();
const groupId = "demo-ui-review-2026";

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const student = await Student.findOne({ email }).lean();
  if (!student) throw new Error(`Student not found for ${email}`);
  if (!student.universityId) throw new Error("Student has no universityId");

  await Event.deleteMany({ groupId });
  await Startup.deleteMany({ ownerEmail: email, name: "Beyond Grades Demo Studio" });
  await Certificate.deleteMany({ email, title: { $in: ["Peer Mentor", "Product Design Sprint"] } });

  const peerOne = { name: "Aarav Mehta", email: "demo.aarav@jklu.edu.in", level: "Senior", committee: "Product" };
  const peerTwo = { name: "Mira Shah", email: "demo.mira@jklu.edu.in", level: "Senior", committee: "Research" };
  await Student.bulkWrite([
    { updateOne: { filter: { email: peerOne.email }, update: { $set: { uid: "demo-aarav-ui", email: peerOne.email, name: peerOne.name, provider: "google", universityId: student.universityId, universityName: student.universityName || "JK Lakshmipat University" } }, upsert: true } },
    { updateOne: { filter: { email: peerTwo.email }, update: { $set: { uid: "demo-mira-ui", email: peerTwo.email, name: peerTwo.name, provider: "google", universityId: student.universityId, universityName: student.universityName || "JK Lakshmipat University" } }, upsert: true } },
  ]);

  const now = new Date();
  const event = await Event.create({
    name: "Product Impact Lab",
    description: "A practice event for building, explaining, and learning from meaningful product work.",
    posterUrl: null,
    eventStartDate: new Date(now.getTime() + 7 * 86400000),
    eventEndDate: new Date(now.getTime() + 8 * 86400000),
    eventDate: new Date(now.getTime() + 7 * 86400000),
    venue: "JKLU Innovation Hub",
    type: "PROJECT",
    createdByEmail: "demo.organizer@jklu.edu.in",
    status: "CLOSED",
    openAt: new Date(now.getTime() - 86400000),
    closeAtTentative: new Date(now.getTime() + 14 * 86400000),
    closeAtActual: now,
    levels: ["Junior", "Senior"],
    skills: ["Communication", "Ownership", "Problem solving"],
    committees: [
      { name: "Product", allowedLevels: ["Junior", "Senior"] },
      { name: "Research", allowedLevels: ["Senior"] },
    ],
    groupId,
    universityId: student.universityId,
    universityName: student.universityName || "JK Lakshmipat University",
    templateId: "T1",
    minAppBuild: 1,
    scoringConfig: {
      scaleMin: 1, scaleMax: 10, levelInfluence: 0.15,
      committeeWeightSame: 1, committeeWeightTop: 0.9, committeeWeightOther: 0.8,
      credibilityEpsilon: 0.1, credibilityShrinkage: 3, confidencePrior: 0.5,
      allowSelfRatings: false, applyRelevanceToSkillWeights: false,
      contributesToScoring: true, showComments: true, identifyRaters: true,
      crossEventRule: "confidence", evenMedianRule: "average",
      blankSkillPolicy: "ignoreSkill", unscoredSkillPolicy: "exclude",
      skillWeights: { Communication: 1, Ownership: 1, "Problem solving": 1 },
      levelRanks: { Junior: 1, Senior: 2 },
      relevance: {
        Product: { Communication: 1, Ownership: 1, "Problem solving": 1 },
        Research: { Communication: 1, Ownership: 1, "Problem solving": 1 },
      },
    },
  });

  await Participant.insertMany([
    { eventId: event._id, email, name: student.name || "Indrajit Roy", level: "Senior", committee: "Product" },
    { eventId: event._id, ...peerOne },
    { eventId: event._id, ...peerTwo },
  ]);

  const ratings = (scores, comment) => ["Communication", "Ownership", "Problem solving"].map((skill, i) => ({ skill, score: scores[i], skipped: false, comment }));
  await FeedbackSubmission.insertMany([
    { eventId: event._id, raterEmail: peerOne.email, targetEmail: email, ratings: ratings([8, 9, 8], "Clear, thoughtful, and dependable in the working session."), submittedAt: now },
    { eventId: event._id, raterEmail: peerTwo.email, targetEmail: email, ratings: ratings([9, 8, 9], "Strong ownership and a calm approach to ambiguous problems."), submittedAt: now },
    { eventId: event._id, raterEmail: email, targetEmail: peerOne.email, ratings: ratings([8, 8, 7], "A reliable collaborator who explains decisions well."), submittedAt: now },
    { eventId: event._id, raterEmail: email, targetEmail: peerTwo.email, ratings: ratings([9, 8, 9], "Excellent research synthesis and follow-through."), submittedAt: now },
  ]);

  const participants = await Participant.find({ eventId: event._id }).lean();
  const submissions = await FeedbackSubmission.find({ eventId: event._id, submittedAt: { $ne: null } }).lean();
  event.frozenScores = {
    ...scoreEvent({
      skills: event.skills,
      participants,
      submissions,
      config: event.scoringConfig,
    }),
    frozenAt: now,
  };
  event.markModified("frozenScores");
  await event.save();

  const startup = await Startup.findOneAndUpdate(
    { ownerEmail: email, name: "Beyond Grades Demo Studio" },
    { ownerEmail: email, name: "Beyond Grades Demo Studio", description: "A small product team building tools for peer learning." },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await Job.create({ startupId: startup._id, title: "Product Research Intern", description: "Help turn student feedback into clear product decisions.", open: true });
  await Certificate.insertMany([
    { email, title: "Peer Mentor", issuer: "Beyond Grades Demo Studio", issuedOn: new Date(now.getTime() - 45 * 86400000) },
    { email, title: "Product Design Sprint", issuer: "JKLU Innovation Hub", issuedOn: new Date(now.getTime() - 120 * 86400000) },
  ]);

  console.log(JSON.stringify({ ok: true, email, eventId: event._id.toString(), groupId, participants: 3, submissions: 4 }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); });
