'use strict';

const express = require('express');
const { randomBytes } = require('crypto');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// GET /api/config?empresa_id=1
router.get('/', async (req, res) => {
  const empresa_id = req.query.empresa_id || 1;
  try {
    const { rows } = await db.query(
      'SELECT clave, valor FROM configuracion WHERE empresa_id=$1',
      [empresa_id]
    );
    const cfg = {};
    rows.forEach(r => { cfg[r.clave] = r.valor; });
    // Nunca exponer el token completo — enmascarar para display
    if (cfg.webhook_token) {
      cfg.webhook_token_preview = cfg.webhook_token.slice(0, 8) + '...' + cfg.webhook_token.slice(-4);
      cfg.webhook_token_full = cfg.webhook_token; // el cliente decide si mostrarlo
    }
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/config
router.put('/', async (req, res) => {
  const { empresa_id = 1, ...updates } = req.body;
  const allowed = ['webhook_enabled'];
  try {
    for (const [clave, valor] of Object.entries(updates)) {
      if (!allowed.includes(clave)) continue;
      await db.query(
        `INSERT INTO configuracion (empresa_id, clave, valor) VALUES ($1,$2,$3)
         ON CONFLICT (empresa_id, clave) DO UPDATE SET valor=$3`,
        [empresa_id, clave, String(valor)]
      );
    }
    // Devolver config actualizada
    const { rows } = await db.query('SELECT clave, valor FROM configuracion WHERE empresa_id=$1', [empresa_id]);
    const cfg = {};
    rows.forEach(r => { cfg[r.clave] = r.valor; });
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config/webhook/regenerar-token
router.post('/webhook/regenerar-token', async (req, res) => {
  const empresa_id = req.body.empresa_id || req.query.empresa_id || 1;
  const newToken = randomBytes(32).toString('hex');
  try {
    await db.query(
      `INSERT INTO configuracion (empresa_id, clave, valor) VALUES ($1,'webhook_token',$2)
       ON CONFLICT (empresa_id, clave) DO UPDATE SET valor=$2`,
      [empresa_id, newToken]
    );
    res.json({ token: newToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
