const test = require("node:test");
const assert = require("node:assert/strict");
const Certificate = require("../models/Certificate");
const Startup = require("../models/Startup");
const Job = require("../models/Job");
const Application = require("../models/Application");
const career = require("./career.controller");
const { resizeSettings } = require("../utils/uploadImage");

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("createCertificate stores a title without inventing a file", async () => {
  const original = Certificate.create;
  try {
    Certificate.create = async (doc) => doc;
    const response = createResponse();
    await career.createCertificate(
      { user: { email: "  A @B.com  " }, body: { title: "  First aid  ", issuer: "Red Cross", issuedOn: "2026-04-01" } },
      response
    );
    assert.equal(response.body.ok, true);
    assert.equal(response.body.certificate.email, "a@b.com");
    assert.equal(response.body.certificate.title, "First aid");
    assert.equal(response.body.certificate.fileUrl, null);
    assert.equal(response.body.certificate.issuedOn.toISOString(), new Date("2026-04-01").toISOString());
  } finally {
    Certificate.create = original;
  }
});

test("listCertificates matches a certificate saved under a different email case", async () => {
  const original = Certificate.find;
  try {
    Certificate.find = (query) => {
      assert.equal(query.$expr.$eq[1], "a@b.com");
      assert.equal(JSON.stringify(query).includes("$email"), true);
      return { sort: () => ({ lean: async () => [{ title: "First aid", email: "A@B.com" }] }) };
    };
    const response = createResponse();
    await career.listCertificates({ user: { email: "A@B.com" } }, response);
    assert.equal(response.body.certificates[0].title, "First aid");
  } finally {
    Certificate.find = original;
  }
});

test("listCertificates trims the signed-in email and reports a load failure", async () => {
  const original = Certificate.find;
  try {
    Certificate.find = (query) => {
      assert.equal(query.$expr.$eq[1], "a@b.com");
      return { sort: () => ({ lean: async () => [{ title: "First aid" }] }) };
    };
    const trimmed = createResponse();
    await career.listCertificates({ user: { email: "  A@B.com  " } }, trimmed);
    assert.equal(trimmed.body.ok, true);
    assert.equal(trimmed.body.certificates[0].title, "First aid");

    Certificate.find = () => {
      throw new Error("db down");
    };
    const failed = createResponse();
    await career.listCertificates({ user: { email: "a@b.com" } }, failed);
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.body.message, "Failed to load certificates");
  } finally {
    Certificate.find = original;
  }
});

test("listJobs reports a load failure", async () => {
  const original = Startup.findOne;
  try {
    Startup.findOne = () => {
      throw new Error("db down");
    };
    const response = createResponse();
    await career.listJobs({ user: { email: "a@b.com" } }, response);
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.message, "Failed to load jobs");
  } finally {
    Startup.findOne = original;
  }
});

test("createCertificate rejects a calendar day that does not exist", async () => {
  const original = Certificate.create;
  try {
    Certificate.create = async () => {
      throw new Error("should not save");
    };
    const response = createResponse();
    await career.createCertificate(
      { user: { email: "a@b.com" }, body: { title: "First aid", issuedOn: "2026-02-31" } },
      response
    );
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.message, "Enter a valid issue date");
  } finally {
    Certificate.create = original;
  }
});

test("createCertificate rejects an invalid issue date", async () => {
  const original = Certificate.create;
  try {
    Certificate.create = async () => {
      throw new Error("should not save");
    };
    const response = createResponse();
    await career.createCertificate(
      { user: { email: "a@b.com" }, body: { title: "First aid", issuedOn: "not-a-date" } },
      response
    );
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.message, "Enter a valid issue date");
  } finally {
    Certificate.create = original;
  }
});

test("createCertificate rejects a blank title", async () => {
  const response = createResponse();
  await career.createCertificate({ user: { email: "a@b.com" }, body: { title: "   " } }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.ok, false);
});

test("registerStartup saves the organization under the signed-in email", async () => {
  const originals = { findOne: Startup.findOne, create: Startup.create };
  try {
    Startup.findOne = async () => null;
    Startup.create = async (doc) => doc;
    const response = createResponse();
    await career.registerStartup(
      { user: { email: "Foun der@Org.com" }, body: { name: "  North Lab  ", description: "Campus startup" } },
      response
    );
    assert.equal(response.body.startup.ownerEmail, "founder@org.com");
    assert.equal(response.body.startup.name, "North Lab");
    assert.equal(response.body.startup.description, "Campus startup");
  } finally {
    Startup.findOne = originals.findOne;
    Startup.create = originals.create;
  }
});

test("registerStartup updates an organization saved under a different email case", async () => {
  const originals = { findOne: Startup.findOne, create: Startup.create };
  const startup = {
    ownerEmail: "Founder@Org.com",
    name: "Old",
    description: "",
    save: async function save() { this.saved = true; },
  };
  try {
    Startup.findOne = async (query) => {
      assert.equal(query.$expr.$eq[1], "founder@org.com");
      assert.equal(JSON.stringify(query).includes("$ownerEmail"), true);
      return startup;
    };
    Startup.create = async () => {
      throw new Error("An existing organization should be updated");
    };
    const response = createResponse();
    await career.registerStartup(
      { user: { email: "founder@org.com" }, body: { name: "North Lab", description: "Campus startup" } },
      response
    );
    assert.equal(response.body.ok, true);
    assert.equal(startup.ownerEmail, "founder@org.com");
    assert.equal(startup.name, "North Lab");
    assert.equal(startup.saved, true);
  } finally {
    Startup.findOne = originals.findOne;
    Startup.create = originals.create;
  }
});

test("createJob stores the role description for the founder's organization", async () => {
  const originals = { startup: Startup.findOne, job: Job.create };
  try {
    Startup.findOne = async () => ({ _id: "startup-1" });
    Job.create = async (doc) => doc;
    const response = createResponse();
    await career.createJob(
      { user: { email: "Founder@Org.com" }, body: { title: "  Intern  ", description: "  Help events  " } },
      response
    );
    assert.equal(response.body.ok, true);
    assert.equal(response.body.job.title, "Intern");
    assert.equal(response.body.job.description, "Help events");
    assert.equal(String(response.body.job.startupId), "startup-1");
  } finally {
    Startup.findOne = originals.startup;
    Job.create = originals.job;
  }
});

test("createJob refuses a posting when the student has no organization", async () => {
  const original = Startup.findOne;
  try {
    Startup.findOne = async () => null;
    const response = createResponse();
    await career.createJob({ user: { email: "a@b.com" }, body: { title: "Intern" } }, response);
    assert.equal(response.statusCode, 403);
    assert.match(response.body.message, /organization/i);
  } finally {
    Startup.findOne = original;
  }
});

test("listOwnJobs attaches applications to the owner's postings", async () => {
  const originals = { startup: Startup.findOne, job: Job.find, application: Application.find };
  try {
    Startup.findOne = async () => ({ _id: "startup-1" });
    Job.find = () => ({
      sort: () => ({
        lean: async () => [{ _id: "job-1", title: "Intern", startupId: "startup-1" }],
      }),
    });
    Application.find = () => ({
      lean: async () => [{ jobId: "job-1", email: "student@x.com", message: "I can help" }],
    });
    const response = createResponse();
    await career.listOwnJobs({ user: { email: "founder@org.com" } }, response);
    assert.equal(response.body.jobs[0].title, "Intern");
    assert.equal(response.body.jobs[0].applications[0].email, "student@x.com");
    assert.equal(response.body.jobs[0].applications[0].message, "I can help");
  } finally {
    Startup.findOne = originals.startup;
    Job.find = originals.job;
    Application.find = originals.application;
  }
});

test("certificate images keep the full page instead of a square crop", () => {
  assert.deepEqual(resizeSettings("inside"), {
    fit: "inside",
    position: "center",
    withoutEnlargement: true,
  });
  assert.equal(resizeSettings().fit, "cover");
  assert.equal(resizeSettings().withoutEnlargement, false);
});

test("listJobs hides the signed-in founder's own postings", async () => {
  const originals = { startup: Startup.findOne, job: Job.find, startups: Startup.find, application: Application.find };
  try {
    let criteria = null;
    Startup.findOne = () => ({ select: () => ({ lean: async () => ({ _id: "startup-1" }) }) });
    Startup.find = () => ({ lean: async () => [] });
    Application.find = () => ({ select: () => ({ lean: async () => [] }) });
    Job.find = (query) => {
      criteria = query;
      return { sort: () => ({ lean: async () => [] }) };
    };
    const response = createResponse();
    await career.listJobs({ user: { email: "Founder@Org.com" } }, response);
    assert.equal(response.body.ok, true);
    assert.equal(criteria.open, true);
    assert.deepEqual(criteria.startupId, { $ne: "startup-1" });
  } finally {
    Startup.findOne = originals.startup;
    Job.find = originals.job;
    Startup.find = originals.startups;
    Application.find = originals.application;
  }
});

test("listJobs marks a job the student already applied to", async () => {
  const originals = { startup: Startup.findOne, job: Job.find, startups: Startup.find, application: Application.find };
  try {
    Startup.findOne = () => ({ select: () => ({ lean: async () => null }) });
    Startup.find = () => ({ lean: async () => [{ _id: "startup-2", name: "North Lab" }] });
    Job.find = () => ({
      sort: () => ({
        lean: async () => [
          { _id: "job-2", title: "Intern", startupId: "startup-2" },
          { _id: "job-3", title: "Mentor", startupId: null },
        ],
      }),
    });
    Application.find = () => ({
      select: () => ({ lean: async () => [{ jobId: "job-2", message: "Ready to start" }] }),
    });
    const response = createResponse();
    await career.listJobs({ user: { email: "student@x.com" } }, response);
    assert.equal(response.body.jobs[0].organization, "North Lab");
    assert.equal(response.body.jobs[0].applied, true);
    assert.equal(response.body.jobs[0].applicationMessage, "Ready to start");
    assert.equal(response.body.jobs[1].organization, "");
    assert.equal(response.body.jobs[1].applied, false);
  } finally {
    Startup.findOne = originals.startup;
    Job.find = originals.job;
    Startup.find = originals.startups;
    Application.find = originals.application;
  }
});

test("closeJob closes the founder's posting and leaves someone else's posting alone", async () => {
  const originals = { startup: Startup.findOne, job: Job.findOne };
  const job = { _id: "job-1", open: true, save: async () => {} };
  try {
    Startup.findOne = () => ({ select: () => ({ lean: async () => ({ _id: "startup-1" }) }) });
    Job.findOne = async (query) => {
      assert.equal(String(query.startupId), "startup-1");
      assert.equal(query._id, "job-1");
      return job;
    };
    const response = createResponse();
    await career.closeJob({ user: { email: "Founder@Org.com" }, params: { jobId: "job-1" } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(job.open, false);

    Startup.findOne = () => ({ select: () => ({ lean: async () => null }) });
    const denied = createResponse();
    await career.closeJob({ user: { email: "student@x.com" }, params: { jobId: "job-1" } }, denied);
    assert.equal(denied.statusCode, 403);
  } finally {
    Startup.findOne = originals.startup;
    Job.findOne = originals.job;
  }
});

test("applyToJob updates an application saved under a different email case", async () => {
  const originals = {
    job: Job.findOne,
    startup: Startup.findOne,
    applicationFind: Application.findOne,
    applicationCreate: Application.create,
  };
  const saved = { email: "Student@X.com", message: "old", save: async function save() { this.saved = true; } };
  try {
    Job.findOne = async () => ({ _id: "job-1", startupId: "startup-1", open: true });
    Startup.findOne = () => ({ select: () => ({ lean: async () => ({ ownerEmail: "founder@org.com" }) }) });
    Application.findOne = async (query) => {
      assert.equal(query.jobId, "job-1");
      assert.equal(query.$expr.$eq[1], "student@x.com");
      return saved;
    };
    Application.create = async () => {
      throw new Error("should update the existing application");
    };
    const response = createResponse();
    await career.applyToJob({ user: { email: "Student@X.com" }, params: { jobId: "job-1" }, body: { message: "Updated note" } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(saved.email, "student@x.com");
    assert.equal(saved.message, "Updated note");
    assert.equal(saved.saved, true);
  } finally {
    Job.findOne = originals.job;
    Startup.findOne = originals.startup;
    Application.findOne = originals.applicationFind;
    Application.create = originals.applicationCreate;
  }
});

test("applyToJob rejects the founder of that job", async () => {
  const originals = { job: Job.findOne, startup: Startup.findOne, application: Application.findOne, applicationCreate: Application.create };
  try {
    Job.findOne = async () => ({ _id: "job-1", startupId: "startup-1", open: true });
    Startup.findOne = () => ({
      select: () => ({ lean: async () => ({ ownerEmail: "  Foun der@Org.com  " }) }),
    });
    Application.findOne = async () => {
      throw new Error("The founder should not be able to apply");
    };
    Application.create = async () => {
      throw new Error("The founder should not be able to apply");
    };
    const response = createResponse();
    await career.applyToJob({ user: { email: "founder@org.com" }, params: { jobId: "job-1" }, body: { message: "Me" } }, response);
    assert.equal(response.statusCode, 403);
    assert.match(response.body.message, /own job/i);
  } finally {
    Job.findOne = originals.job;
    Startup.findOne = originals.startup;
    Application.findOne = originals.application;
    Application.create = originals.applicationCreate;
  }
});

test("applyToJob rejects a job that is not open", async () => {
  const original = Job.findOne;
  try {
    Job.findOne = async () => null;
    const response = createResponse();
    await career.applyToJob({ user: { email: "a@b.com" }, params: { jobId: "missing" }, body: {} }, response);
    assert.equal(response.statusCode, 404);
  } finally {
    Job.findOne = original;
  }
});
