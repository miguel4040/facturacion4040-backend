'use strict';

const fs   = require('fs');
const path = require('path');
const { pool } = require('./index');

const INIT_SQL = path.join(__dirname, '../../db/init.sql');

async function initDb() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'usuarios'
    `);

    if (rows.length > 0) {
      console.log('   DB: schema ya existe, omitiendo init.sql');
      return;
    }

    console.log('   DB: schema no encontrado, ejecutando init.sql...');
    const sql = fs.readFileSync(INIT_SQL, 'utf8');
    await client.query(sql);
    console.log('   DB: schema creado correctamente ✓');
  } finally {
    client.release();
  }
}

module.exports = initDb;
