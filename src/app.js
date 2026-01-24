const express = require("express");
const cors = require("cors");

const app = express();
const appRoutes = require("./routes/app.routes");

app.use(cors());
app.use(express.json());
app.use("/auth", require("./routes/auth.routes"));
app.use("/events", require("./routes/events.routes"));
app.use("/students", require("./routes/students.routes"));
app.use("/universities", require("./routes/universities.routes"));
app.use("/app", appRoutes);

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Beyond Grades backend running" });
});

module.exports = app;