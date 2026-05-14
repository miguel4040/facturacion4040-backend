'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

router.get('/', async (req, res) => {
  const { empresa_id, q } = req.query;
  try {
    let sql = 'SELECT * FROM productos WHERE activo = true';
    const params = [];
    if (empresa_id) { params.push(empresa_id); sql += ` AND empresa_id = $${params.length}`; }
    if (q) { params.push(`%${q}%`); sql += ` AND (descripcion ILIKE $${params.length} OR clave_interna ILIKE $${params.length})`; }
    sql += ' ORDER BY descripcion';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM productos WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { empresa_id, clave_interna, clave_prod_serv, clave_unidad, unidad, descripcion, precio_unitario, objeto_imp, tasa_iva } = req.body;
  if (!empresa_id || !descripcion || !precio_unitario) {
    return res.status(400).json({ error: 'empresa_id, descripción y precio son requeridos' });
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO productos (empresa_id, clave_interna, clave_prod_serv, clave_unidad, unidad, descripcion, precio_unitario, objeto_imp, tasa_iva)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [empresa_id, clave_interna || null, clave_prod_serv || '01010101', clave_unidad || 'E48',
       unidad || 'Servicio', descripcion, precio_unitario, objeto_imp || '02', tasa_iva ?? 0.16]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { clave_interna, clave_prod_serv, clave_unidad, unidad, descripcion, precio_unitario, objeto_imp, tasa_iva } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE productos SET clave_interna=$1, clave_prod_serv=$2, clave_unidad=$3, unidad=$4,
       descripcion=$5, precio_unitario=$6, objeto_imp=$7, tasa_iva=$8 WHERE id=$9 RETURNING *`,
      [clave_interna || null, clave_prod_serv || '01010101', clave_unidad || 'E48',
       unidad || 'Servicio', descripcion, precio_unitario, objeto_imp || '02', tasa_iva ?? 0.16, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.query('UPDATE productos SET activo = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
