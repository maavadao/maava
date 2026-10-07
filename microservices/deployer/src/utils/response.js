/**
 * Response helpers
 */

function success(res, data, statusCode = 200) {
  res.status(statusCode).json({
    success: true,
    ...data,
  });
}

function created(res, data) {
  success(res, data, 201);
}

module.exports = {
  success,
  created,
};
