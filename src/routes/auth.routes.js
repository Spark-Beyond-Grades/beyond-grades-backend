const express = require("express");
const router = express.Router();

const { syncAuthority } = require("../controllers/auth.controller");

router.post("/sync", syncAuthority);

module.exports = router;