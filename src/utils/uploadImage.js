const crypto = require("crypto");
const sharp = require("sharp");
const { cloudinary } = require("../config/cloudinary");

/**
 * Upload a buffer to Cloudinary after optional resize.
 * @param {Buffer} buffer
 * @param {string} fileName
 * @param {string} folder Cloudinary folder (e.g. event-posters)
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @returns {Promise<string>} secure_url
 */
async function uploadImage(
  buffer,
  fileName,
  folder = "general",
  targetWidth = 512,
  targetHeight = 512
) {
  const processedBuffer = await sharp(buffer)
    .resize(targetWidth, targetHeight, {
      fit: "cover",
      position: "center",
      withoutEnlargement: false,
    })
    .jpeg({ quality: 80 })
    .toBuffer();

  const randomName = crypto.randomBytes(16).toString("hex");
  const publicId = `${folder}/${randomName}`;

  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: "image",
        overwrite: false,
        format: "jpg",
      },
      (err, uploaded) => {
        if (err) reject(err);
        else resolve(uploaded);
      }
    );
    stream.end(processedBuffer);
  });

  return result.secure_url;
}

/**
 * Best-effort delete of a Cloudinary asset by delivery URL.
 * @param {string} url
 */
async function deleteCloudinaryUrl(url) {
  if (!url || typeof url !== "string") return;
  if (!url.includes("res.cloudinary.com")) return;

  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+(?:\?|$)/);
    if (!match) return;
    const publicId = decodeURIComponent(match[1]);
    await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
  } catch (err) {
    console.warn("Failed to delete Cloudinary asset:", err.message);
  }
}

module.exports = { uploadImage, deleteCloudinaryUrl };
