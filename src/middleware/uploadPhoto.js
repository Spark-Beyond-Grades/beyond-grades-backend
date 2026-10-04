const multer = require("multer");

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB limit
});

const certificateUpload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
});

function certificateUploadError(err) {
  if (!err) return null;
  if (err.code === "LIMIT_FILE_SIZE") {
    return { status: 400, message: "Certificate image must be 8 MB or smaller" };
  }
  return { status: 400, message: "Could not read the certificate image" };
}

function receiveCertificateImage(req, res, next) {
  certificateUpload.single("file")(req, res, (err) => {
    const failure = certificateUploadError(err);
    if (!failure) return next();
    return res.status(failure.status).json({ ok: false, message: failure.message });
  });
}

module.exports = upload;
module.exports.receiveCertificateImage = receiveCertificateImage;
module.exports.certificateUploadError = certificateUploadError;