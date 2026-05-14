'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

router.get('/', async (req, res) => {
  const { empresa_id, q } = req.query;
  try {
    let sql = 'SELECT * FROM clientes WHERE activo = true';
    const params = [];
    if (empresa_id) { params.push(empresa_id); sql += ` AND empresa_id = $${params.length}`; }
    if (q) { params.push(`%${q}%`); sql += ` AND (nombre ILIKE $${params.length} OR rfc ILIKE $${params.length})`; }
    sql += ' ORDER BY nombre';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { empresa_id, rfc, nombre, regimen_fiscal, codigo_postal, email, telefono, uso_cfdi_default } = req.body;
  if (!empresa_id || !rfc || !nombre || !codigo_postal) {
    return res.status(400).json({ error: 'empresa_id, RFC, nombre y código postal son requeridos' });
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO clientes (empresa_id, rfc, nombre, regimen_fiscal, codigo_postal, email, telefono, uso_cfdi_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [empresa_id, rfc.toUpperCase(), nombre, regimen_fiscal || '616', codigo_postal,
       email || null, telefono || null, uso_cfdi_default || 'G03']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'El RFC ya existe para esta empresa' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { rfc, nombre, regimen_fiscal, codigo_postal, email, telefono, uso_cfdi_default } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE clientes SET rfc=$1, nombre=$2, regimen_fiscal=$3, codigo_postal=$4,
       email=$5, telefono=$6, uso_cfdi_default=$7 WHERE id=$8 RETURNING *`,
      [rfc?.toUpperCase(), nombre, regimen_fiscal || '616', codigo_postal,
       email || null, telefono || null, uso_cfdi_default || 'G03', req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.query('UPDATE clientes SET activo = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
