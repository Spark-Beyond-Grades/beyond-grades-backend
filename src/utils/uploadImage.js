const { s3 } = require("../config/spaces");
const crypto = require("crypto");
const { Upload } = require("@aws-sdk/lib-storage");

/**
 * Uploads a buffer to DigitalOcean Spaces.
 * @param {Buffer} buffer - The file buffer.
 * @param {string} fileName - Original file name.
 * @param {string} folder - Folder in the bucket (e.g., 'event-posters').
 * @returns {Promise<string>} - The URL of the uploaded image.
 */
async function uploadToSpaces(buffer, fileName, folder = "general") {
  const fileExtension = fileName.split(".").pop().toLowerCase();
  const randomName = crypto.randomBytes(16).toString("hex");
  const key = `${folder}/${randomName}.${fileExtension}`;

  const params = {
    Bucket: process.env.DO_SPACES_BUCKET,
    Key: key,
    Body: buffer,
    ACL: "public-read",
    ContentType: `image/${fileExtension === "jpg" ? "jpeg" : fileExtension}`,
  };

  const uploadResult = await new Upload({
    client: s3,
    params,
  }).done();
  
  if (process.env.DO_SPACES_CDN_BASE) {
    return `${process.env.DO_SPACES_CDN_BASE}/${key}`;
  }
  
  return uploadResult.Location;
}

module.exports = { uploadToSpaces };
