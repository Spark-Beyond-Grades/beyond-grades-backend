require("dotenv").config();
const mongoose = require("mongoose");
const Startup = require("../src/models/Startup");
const Job = require("../src/models/Job");
const Certificate = require("../src/models/Certificate");

async function main() {
  const email = (process.argv[2] || "roybengali203@gmail.com").toLowerCase();
  await mongoose.connect(process.env.MONGODB_URI);
  const startup = await Startup.findOneAndUpdate(
    { ownerEmail: email, name: "Beyond Grades Demo Studio" },
    { ownerEmail: email, name: "Beyond Grades Demo Studio", description: "A small product team building tools for peer learning." },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await Job.deleteMany({ startupId: startup._id });
  await Job.create({ startupId: startup._id, title: "Product Research Intern", description: "Help turn student feedback into clear product decisions.", open: true });
  await Certificate.deleteMany({ email, title: { $in: ["Peer Mentor", "Product Design Sprint"] } });
  await Certificate.insertMany([
    { email, title: "Peer Mentor", issuer: "Beyond Grades Demo Studio", issuedOn: new Date(Date.now() - 45 * 86400000) },
    { email, title: "Product Design Sprint", issuer: "JKLU Innovation Hub", issuedOn: new Date(Date.now() - 120 * 86400000) },
  ]);
  console.log(JSON.stringify({ ok: true, email, startupId: startup._id.toString() }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); });
