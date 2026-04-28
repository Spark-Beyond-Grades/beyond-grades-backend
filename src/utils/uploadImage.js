const { s3 } = require("../config/spaces");
const crypto = require("crypto");
const { Upload } = require("@aws-sdk/lib-storage");
const sharp = require("sharp");

/**
 * Uploads a buffer to DigitalOcean Spaces.
 * @param {Buffer} buffer - The file buffer.
 * @param {string} fileName - Original file name.
 * @param {string} folder - Folder in the bucket (e.g., 'event-posters').
 * @param {number} targetWidth - Target width for image resizing.
 * @param {number} targetHeight - Target height for image resizing.
 * @returns {Promise<string>} - The URL of the uploaded image.
 */
async function uploadToSpaces(buffer, fileName, folder = "general", targetWidth = 512, targetHeight = 512) {
  // Resize before uploading
  const processedBuffer = await sharp(buffer)
    .resize(targetWidth, targetHeight, {
      fit: "cover",
      position: "center",
      withoutEnlargement: false
    })
    .toBuffer();

  const fileExtension = fileName.split(".").pop().toLowerCase();
  const randomName = crypto.randomBytes(16).toString("hex");
  const key = `${folder}/${randomName}.${fileExtension}`;

  const params = {
    Bucket: process.env.DO_SPACES_BUCKET,
    Key: key,
    Body: processedBuffer,
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
