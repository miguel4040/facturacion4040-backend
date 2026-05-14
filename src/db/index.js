const { Pool } = require('pg');
const config = require('../config/config');

const pool = new Pool(config.db);

pool.on('error', (err) => {
  console.error('Unexpected DB error:', err.message);
});

const query = (text, params) => pool.query(text, params);

module.exports = { query, pool };
