const { S3Client } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  endpoint: process.env.DO_SPACES_ENDPOINT,
  region: process.env.DO_SPACES_REGION || "sgp1",
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY || "",
    secretAccessKey: process.env.DO_SPACES_SECRET || "",
  },
});

module.exports = { s3 };
