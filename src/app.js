const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());
app.use("/auth", require("./routes/auth.routes"));
app.use("/events", require("./routes/events.routes"));


app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Beyond Grades backend running" });
});

module.exports = app;