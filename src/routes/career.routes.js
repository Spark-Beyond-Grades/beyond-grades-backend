const router = require("express").Router();
const requireStudent = require("../middleware/requireStudent");
const { receiveCertificateImage } = require("../middleware/uploadPhoto");
const career = require("../controllers/career.controller");

router.get("/certificates", requireStudent, career.listCertificates);
router.post("/certificates", requireStudent, receiveCertificateImage, career.createCertificate);
router.post("/startups", requireStudent, career.registerStartup);
router.get("/jobs", requireStudent, career.listJobs);
router.post("/jobs", requireStudent, career.createJob);
router.get("/jobs/mine", requireStudent, career.listOwnJobs);
router.post("/jobs/:jobId/close", requireStudent, career.closeJob);
router.post("/jobs/:jobId/apply", requireStudent, career.applyToJob);

module.exports = router;
