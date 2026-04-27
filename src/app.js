const express = require("express");
const cors = require("cors");

const app = express();
const appRoutes = require("./routes/app.routes");

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (allowedOrigins.length === 0 && process.env.NODE_ENV !== "production") {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.json({ limit: "1mb" }));
app.use("/auth", require("./routes/auth.routes"));
app.use("/events", require("./routes/events.routes"));
app.use("/students", require("./routes/students.routes"));
app.use("/universities", require("./routes/universities.routes"));
app.use("/app", appRoutes);

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Beyond Grades backend running" });
});

app.use((err, req, res, next) => {
  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({ ok: false, message: "Origin not allowed" });
  }

  if (err.name === "MulterError" || /Only .* allowed/.test(err.message)) {
    return res.status(400).json({ ok: false, message: err.message });
  }

  console.error("Unhandled error:", err.message);
  return res.status(500).json({ ok: false, message: "Internal server error" });
});

module.exports = app;
