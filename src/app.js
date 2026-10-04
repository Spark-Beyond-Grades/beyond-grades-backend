const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

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
app.use("/career", require("./routes/career.routes"));
app.use("/universities", require("./routes/universities.routes"));
app.use("/app", appRoutes);

app.get("/health", async (req, res) => {
  const startedAt = process.hrtime.bigint();
  console.log("Health check started");

  const latencyMs = () => Number((process.hrtime.bigint() - startedAt) / 1000000n);

  try {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
      throw new Error("MongoDB connection is not active");
    }

    await mongoose.connection.db.admin().ping();
    console.log("DB ping success");

    await mongoose.connection.db.collection("universities").findOne(
      {},
      {
        projection: { _id: 1 },
        maxTimeMS: 1000,
      }
    );

    const memoryUsage = process.memoryUsage();
    const latency = latencyMs();
    console.log(`Health check latency: ${latency}ms`);

    return res.json({
      ok: true,
      database: true,
      latency,
      uptime: Math.round(process.uptime()),
      memory: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      },
    });
  } catch (err) {
    const latency = latencyMs();
    console.error("DB ping failure:", err.message);
    console.log(`Health check latency: ${latency}ms`);
    return res.status(500).json({ ok: false });
  }
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
