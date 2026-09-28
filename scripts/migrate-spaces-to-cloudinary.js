/**
 * One-time migration: Spaces / CDN image URLs in MongoDB → Cloudinary.
 *
 * Usage (from beyond-grades-backend):
 *   node scripts/migrate-spaces-to-cloudinary.js
 *   node scripts/migrate-spaces-to-cloudinary.js --dry-run
 *
 * Requires MONGODB_URI and CLOUDINARY_URL (or CLOUDINARY_* vars).
 */
require("dotenv").config();

const mongoose = require("mongoose");
const crypto = require("crypto");
const { cloudinary } = require("../src/config/cloudinary");

const DRY_RUN = process.argv.includes("--dry-run");

const SPACE_HOST_HINTS = [
  "digitaloceanspaces.com",
  "cdn.digitaloceanspaces.com",
  "cdn.touchapp.live",
];

if (process.env.DO_SPACES_CDN_BASE) {
  try {
    SPACE_HOST_HINTS.push(new URL(process.env.DO_SPACES_CDN_BASE).host);
  } catch {
    /* ignore */
  }
}

function isSpacesUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (url.includes("res.cloudinary.com")) return false;
  try {
    const host = new URL(url).host.toLowerCase();
    return SPACE_HOST_HINTS.some((hint) => host.includes(hint.toLowerCase()));
  } catch {
    return SPACE_HOST_HINTS.some((hint) => url.includes(hint));
  }
}

function candidateUrls(url) {
  const urls = [url];
  try {
    const u = new URL(url);
    if (u.host.includes("cdn.touchapp.live")) {
      urls.push(`https://touchapp-media.sgp1.digitaloceanspaces.com${u.pathname}`);
      urls.push(`https://sgp1.digitaloceanspaces.com/touchapp-media${u.pathname}`);
    }
  } catch {
    /* ignore */
  }
  return [...new Set(urls)];
}

async function downloadBuffer(url) {
  let lastErr;
  for (const candidate of candidateUrls(url)) {
    try {
      const res = await fetch(candidate, {
        redirect: "follow",
        headers: { "User-Agent": "beyond-grades-migrator/1.0" },
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} for ${candidate}`);
        continue;
      }
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`Failed to download ${url}`);
}

async function uploadBufferToCloudinary(buffer, folder, publicIdHint) {
  const publicId = `${folder}/${publicIdHint || crypto.randomBytes(12).toString("hex")}`;
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: "image",
        overwrite: true,
        invalidate: true,
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
}

async function migrateField({ collection, filter, field, folder }) {
  const cursor = collection.find({
    ...filter,
    [field]: { $type: "string", $ne: "" },
  });

  let scanned = 0;
  let candidates = 0;
  let migrated = 0;
  let failed = 0;
  let skipped = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    scanned += 1;
    const oldUrl = doc[field];
    if (!isSpacesUrl(oldUrl)) {
      skipped += 1;
      continue;
    }
    candidates += 1;

    try {
      console.log(`[${collection.collectionName}.${field}] ${doc._id}: ${oldUrl}`);
      if (DRY_RUN) {
        migrated += 1;
        continue;
      }

      const buffer = await downloadBuffer(oldUrl);
      const hint = crypto.createHash("sha1").update(oldUrl).digest("hex").slice(0, 16);
      const uploaded = await uploadBufferToCloudinary(buffer, folder, hint);
      await collection.updateOne(
        { _id: doc._id },
        { $set: { [field]: uploaded.secure_url } }
      );
      migrated += 1;
      console.log(`  → ${uploaded.secure_url}`);
    } catch (err) {
      failed += 1;
      console.warn(`  ✗ ${err.message}`);
    }
  }

  return { scanned, candidates, migrated, failed, skipped };
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required");
  }
  if (
    !process.env.CLOUDINARY_URL &&
    !(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
  ) {
    throw new Error("CLOUDINARY_URL or CLOUDINARY_* credentials are required");
  }

  console.log(DRY_RUN ? "=== DRY RUN (no writes) ===" : "=== MIGRATING ===");
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const jobs = [
    {
      collection: db.collection("students"),
      filter: {},
      field: "photoUrl",
      folder: "beyond-grades/migrated/students",
    },
    {
      collection: db.collection("events"),
      filter: {},
      field: "posterUrl",
      folder: "beyond-grades/migrated/event-posters",
    },
    {
      collection: db.collection("events"),
      filter: {},
      field: "logoUrl",
      folder: "beyond-grades/migrated/event-logos",
    },
  ];

  const summary = [];
  for (const job of jobs) {
    const result = await migrateField(job);
    summary.push({
      target: `${job.collection.collectionName}.${job.field}`,
      ...result,
    });
  }

  console.log("\n=== SUMMARY ===");
  console.table(summary);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
