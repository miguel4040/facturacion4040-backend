'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const db = require('../db');
const auth = require('../middleware/auth');

const CERTS_BASE = path.join(__dirname, '../certificados_prueba');

const router = express.Router();
router.use(auth);

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM empresas WHERE activo = true ORDER BY nombre');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM empresas WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Empresa no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { rfc, nombre, regimen_fiscal, codigo_postal, telefono, email } = req.body;
  if (!rfc || !nombre || !regimen_fiscal || !codigo_postal) {
    return res.status(400).json({ error: 'RFC, nombre, régimen fiscal y código postal son requeridos' });
  }
  try {
    const { rows } = await db.query(
      'INSERT INTO empresas (rfc, nombre, regimen_fiscal, codigo_postal, telefono, email) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [rfc.toUpperCase(), nombre, regimen_fiscal, codigo_postal, telefono || null, email || null]
    );
    // Crear serie por defecto
    await db.query(
      'INSERT INTO series (empresa_id, serie, tipo_comprobante, folio_actual) VALUES ($1, $2, $3, 1) ON CONFLICT DO NOTHING',
      [rows[0].id, 'A', 'I']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'El RFC ya existe' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { rfc, nombre, regimen_fiscal, codigo_postal, telefono, email } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE empresas SET rfc=$1, nombre=$2, regimen_fiscal=$3, codigo_postal=$4, telefono=$5, email=$6
       WHERE id=$7 RETURNING *`,
      [rfc?.toUpperCase(), nombre, regimen_fiscal, codigo_postal, telefono || null, email || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Empresa no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar certificados de prueba disponibles
router.get('/certificados/lista', async (req, res) => {
  try {
    const certs = [];
    const tipos = ['Personas Morales', 'Personas Fisicas'];

    for (const tipo of tipos) {
      const tipoDir = path.join(CERTS_BASE, tipo);
      if (!fs.existsSync(tipoDir)) continue;

      const entidades = fs.readdirSync(tipoDir).filter(d =>
        fs.statSync(path.join(tipoDir, d)).isDirectory()
      );

      for (const entidad of entidades) {
        const entDir = path.join(tipoDir, entidad);
        const cerFiles = fs.readdirSync(entDir).filter(f => f.endsWith('.cer'));
        const keyFiles = fs.readdirSync(entDir).filter(f => f.endsWith('.key'));
        if (!cerFiles.length || !keyFiles.length) continue;

        // Leer el primer .cer para extraer RFC y Nombre
        const cerPath = path.join(entDir, cerFiles[0]);
        try {
          const buf = fs.readFileSync(cerPath);
          let binary = '';
          for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
          const asn1 = forge.asn1.fromDer(binary);
          const cert = forge.pki.certificateFromAsn1(asn1);

          const cn = cert.subject.attributes.find(a => a.name === 'commonName')?.value || entidad;
          const rfcAttr = cert.subject.attributes.find(a => a.type === '2.5.4.45')?.value || '';
          const rfc = rfcAttr.split(' / ')[0].trim();
          const noCert = Buffer.from(cert.serialNumber, 'hex').toString('ascii').replace(/\x00/g, '');

          certs.push({
            tipo,
            rfc,
            nombre: cn,
            noCertificado: noCert,
            cerPath: path.join('/app/src/certificados_prueba', tipo, entidad, cerFiles[0]),
            keyPath: path.join('/app/src/certificados_prueba', tipo, entidad, keyFiles[0]),
            password: '12345678a',
          });
        } catch { /* skip bad cert */ }
      }
    }

    res.json(certs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activar un certificado: actualiza .env en memoria y empresa en DB
router.post('/certificados/activar', async (req, res) => {
  const { empresa_id, rfc, nombre, regimen_fiscal, codigo_postal, cerPath, keyPath, password } = req.body;
  if (!rfc || !nombre || !cerPath || !keyPath) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  try {
    // Actualizar la empresa en la DB
    const id = empresa_id || 1;
    const cp = codigo_postal || '01030';
    const rf = regimen_fiscal || '601';
    const { rows } = await db.query(
      'UPDATE empresas SET rfc=$1, nombre=$2, regimen_fiscal=$3, codigo_postal=$4 WHERE id=$5 RETURNING *',
      [rfc.toUpperCase(), nombre, rf, cp, id]
    );

    // Actualizar config en memoria para la sesión actual
    const config = require('../config/config');
    config.cfdi.csd.rfc = rfc.toUpperCase();
    config.cfdi.csd.cerPath = cerPath;
    config.cfdi.csd.keyPath = keyPath;
    config.cfdi.csd.password = password || '12345678a';

    // Actualizar .env para persistir (ruta relativa al proyecto)
    const envPath = path.join(__dirname, '../../../../.env');
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf8');
      envContent = envContent.replace(/CSD_RFC=.*/, `CSD_RFC=${rfc.toUpperCase()}`);
      envContent = envContent.replace(/CSD_CER_PATH=.*/, `CSD_CER_PATH=${cerPath}`);
      envContent = envContent.replace(/CSD_KEY_PATH=.*/, `CSD_KEY_PATH=${keyPath}`);
      envContent = envContent.replace(/CSD_PASSWORD=.*/, `CSD_PASSWORD=${password || '12345678a'}`);
      fs.writeFileSync(envPath, envContent);
    }

    res.json({ ok: true, empresa: rows[0], csd: { rfc, cerPath, keyPath } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Series y folios
router.get('/:id/series', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM series WHERE empresa_id = $1 AND activo = true',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
