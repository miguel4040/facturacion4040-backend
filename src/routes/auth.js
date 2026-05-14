'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config/config');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

  try {
    const { rows } = await db.query(
      'SELECT * FROM usuarios WHERE email = $1 AND activo = true',
      [email.toLowerCase()]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign(
      { id: user.id, email: user.email, nombre: user.nombre, rol: user.rol },
      config.jwtSecret,
      { expiresIn: '24h' }
    );

    res.json({ token, user: { id: user.id, email: user.email, nombre: user.nombre, rol: user.rol } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/register', async (req, res) => {
  const { email, password, nombre } = req.body;
  if (!email || !password || !nombre) return res.status(400).json({ error: 'Todos los campos son requeridos' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      'INSERT INTO usuarios (email, password_hash, nombre) VALUES ($1, $2, $3) RETURNING id, email, nombre',
      [email.toLowerCase(), hash, nombre]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'El email ya existe' });
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
