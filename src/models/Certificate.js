const mongoose = require("mongoose");

const CertificateSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    title: { type: String, required: true, trim: true },
    issuer: { type: String, trim: true, default: "" },
    fileUrl: { type: String, default: null },
    issuedOn: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Certificate", CertificateSchema);
