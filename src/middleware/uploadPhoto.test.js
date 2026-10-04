const test = require("node:test");
const assert = require("node:assert/strict");
const { certificateUploadError } = require("./uploadPhoto");

test("a certificate image over 8 MB reports the size limit", () => {
  assert.deepEqual(certificateUploadError({ code: "LIMIT_FILE_SIZE" }), {
    status: 400,
    message: "Certificate image must be 8 MB or smaller",
  });
  assert.equal(certificateUploadError(null), null);
  assert.match(certificateUploadError(new Error("bad image")).message, /could not read/i);
});
