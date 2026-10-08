/**
 * Database connection pool shared across the mawa-channels service.
 */
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.database.url,
  ssl: config.database.url ? { rejectUnauthorized: false } : false,
  max: 10,
});

module.exports = pool;
