const AWS = require("aws-sdk");

const endpoint = new AWS.Endpoint(process.env.DO_SPACES_ENDPOINT);

const s3 = new AWS.S3({
  endpoint,
  accessKeyId: process.env.DO_SPACES_KEY,
  secretAccessKey: process.env.DO_SPACES_SECRET,
});

module.exports = { s3 };