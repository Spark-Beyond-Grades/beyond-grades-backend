const Certificate = require("../models/Certificate");
const Startup = require("../models/Startup");
const Job = require("../models/Job");
const Application = require("../models/Application");
const Student = require("../models/Student");
const { uploadImage } = require("../utils/uploadImage");
const { emailMatchQuery } = require("../utils/emailQuery");
const { cleanEmail } = require("../utils/csvMatch");
const { calendarDate } = require("../utils/calendarDate");

exports.listCertificates = async (req, res) => {
  try {
    const email = cleanEmail(req.user?.email);
    const certificates = await Certificate.find(emailMatchQuery("email", email)).sort({ createdAt: -1 }).lean();
    return res.json({ ok: true, certificates });
  } catch (err) {
    console.error("listCertificates error:", err);
    return res.status(500).json({ ok: false, message: "Failed to load certificates" });
  }
};

function certificateIssueDate(value) {
  return calendarDate(value);
}

exports.createCertificate = async (req, res) => {
  try {
    const email = cleanEmail(req.user?.email);
    const title = String(req.body?.title || "").trim();
    if (!title) return res.status(400).json({ ok: false, message: "Title is required" });
    let fileUrl = null;
    if (req.file) {
      fileUrl = await uploadImage(req.file.buffer, `${Date.now()}.jpg`, `beyond-grades/certificates/${email}`, 1600, 2200, "inside");
    }
    const issuedOn = certificateIssueDate(req.body?.issuedOn);
    if (issuedOn?.invalid) {
      return res.status(400).json({ ok: false, message: "Enter a valid issue date" });
    }
    const certificate = await Certificate.create({
      email,
      title,
      issuer: String(req.body?.issuer || "").trim(),
      issuedOn,
      fileUrl,
    });
    return res.json({ ok: true, certificate });
  } catch (err) {
    console.error("createCertificate error:", err);
    return res.status(500).json({ ok: false, message: "Failed to save certificate" });
  }
};

exports.registerStartup = async (req, res) => {
  try {
    const ownerEmail = cleanEmail(req.user?.email);
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, message: "Organization name is required" });
    const description = String(req.body?.description || "").trim();
    const existing = await Startup.findOne(emailMatchQuery("ownerEmail", ownerEmail));
    if (existing) {
      existing.name = name;
      existing.description = description;
      existing.ownerEmail = ownerEmail;
      await existing.save();
      return res.json({ ok: true, startup: existing });
    }
    const startup = await Startup.create({ ownerEmail, name, description });
    return res.json({ ok: true, startup });
  } catch (err) {
    console.error("registerStartup error:", err);
    return res.status(500).json({ ok: false, message: "Failed to register organization" });
  }
};

exports.listJobs = async (req, res) => {
  try {
  const email = cleanEmail(req.user?.email);
  const own = await Startup.findOne(emailMatchQuery("ownerEmail", email)).select("_id").lean();
  const criteria = { open: true };
  if (own) criteria.startupId = { $ne: own._id };
  const jobs = await Job.find(criteria).sort({ createdAt: -1 }).lean();
  const startups = await Startup.find({ _id: { $in: jobs.map((job) => job.startupId).filter(Boolean) } }).lean();
  const byId = new Map(startups.map((startup) => [startup._id.toString(), startup]));
  const applications = await Application.find({
    ...emailMatchQuery("email", email),
    jobId: { $in: jobs.map((job) => job._id) },
  }).select("jobId message").lean();
  const messageByJob = new Map(applications.map((application) => [String(application.jobId), application.message || ""]));
  return res.json({
    ok: true,
    jobs: jobs.map((job) => ({
      ...job,
      organization: job.startupId ? byId.get(String(job.startupId))?.name || "" : "",
      applied: messageByJob.has(String(job._id)),
      applicationMessage: messageByJob.get(String(job._id)) || "",
    })),
  });
  } catch (err) {
    console.error("listJobs error:", err);
    return res.status(500).json({ ok: false, message: "Failed to load jobs" });
  }
};

exports.createJob = async (req, res) => {
  try {
    const startup = await Startup.findOne(emailMatchQuery("ownerEmail", cleanEmail(req.user?.email)));
    if (!startup) return res.status(403).json({ ok: false, message: "Register an organization first" });
    const title = String(req.body?.title || "").trim();
    if (!title) return res.status(400).json({ ok: false, message: "Job title is required" });
    const job = await Job.create({
      startupId: startup._id,
      title,
      description: String(req.body?.description || "").trim(),
    });
    return res.json({ ok: true, job });
  } catch (err) {
    console.error("createJob error:", err);
    return res.status(500).json({ ok: false, message: "Failed to post job" });
  }
};

exports.listOwnJobs = async (req, res) => {
  try {
  const startup = await Startup.findOne(emailMatchQuery("ownerEmail", cleanEmail(req.user?.email)));
  if (!startup) return res.json({ ok: true, startup: null, jobs: [] });
  const jobs = await Job.find({ startupId: startup._id }).sort({ createdAt: -1 }).lean();
  const applications = await Application.find({ jobId: { $in: jobs.map((job) => job._id) } }).lean();
  const applicantEmails = [...new Set(applications.map((application) => cleanEmail(application.email)).filter(Boolean))];
  const applicants = applicantEmails.length
    ? await Student.find(emailMatchQuery("email", applicantEmails)).select("email name").lean()
    : [];
  const nameByEmail = new Map();
  for (const applicant of applicants) {
    const address = cleanEmail(applicant.email);
    const name = String(applicant.name || "").trim();
    if (address && name && !nameByEmail.has(address)) nameByEmail.set(address, name);
  }
  return res.json({
    ok: true,
    startup,
    jobs: jobs.map((job) => ({
      ...job,
      applications: applications
        .filter((application) => String(application.jobId) === String(job._id))
        .map((application) => ({
          ...application,
          name: nameByEmail.get(cleanEmail(application.email)) || "",
        })),
    })),
  });
  } catch (err) {
    console.error("listOwnJobs error:", err);
    return res.status(500).json({ ok: false, message: "Failed to load your jobs" });
  }
};

exports.closeJob = async (req, res) => {
  try {
    const email = cleanEmail(req.user?.email);
    const startup = await Startup.findOne(emailMatchQuery("ownerEmail", email)).select("_id").lean();
    if (!startup) return res.status(403).json({ ok: false, message: "Register an organization first" });
    const job = await Job.findOne({ _id: req.params.jobId, startupId: startup._id });
    if (!job) return res.status(404).json({ ok: false, message: "Job not found" });
    job.open = false;
    await job.save();
    return res.json({ ok: true, job });
  } catch (err) {
    console.error("closeJob error:", err);
    return res.status(500).json({ ok: false, message: "Failed to close job" });
  }
};

exports.applyToJob = async (req, res) => {
  try {
    const email = cleanEmail(req.user?.email);
    const job = await Job.findOne({ _id: req.params.jobId, open: true });
    if (!job) return res.status(404).json({ ok: false, message: "Job not found" });
    const startup = await Startup.findOne({ _id: job.startupId }).select("ownerEmail").lean();
    if (startup && cleanEmail(startup.ownerEmail) === email) {
      return res.status(403).json({ ok: false, message: "You cannot apply to your own job" });
    }
    const message = String(req.body?.message || "").trim();
    const existing = await Application.findOne({ jobId: job._id, ...emailMatchQuery("email", email) });
    if (existing) {
      existing.email = email;
      existing.message = message;
      await existing.save();
      return res.json({ ok: true, application: existing });
    }
    const application = await Application.create({ jobId: job._id, email, message });
    return res.json({ ok: true, application });
  } catch (err) {
    console.error("applyToJob error:", err);
    return res.status(500).json({ ok: false, message: "Failed to apply" });
  }
};
