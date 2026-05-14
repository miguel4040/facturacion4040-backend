'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const auth = require('../middleware/auth');
const { buildCFDI40 } = require('../services/xmlBuilder');
const { timbrarCFDI } = require('../services/cfdiService');

// ── Helper: build CFDI and factura records from a venta ───────────────────
async function crearFacturaDesdeVenta(client, venta, receptor, empresa) {
  // Load multiproduct conceptos (backfilled for legacy single-product ventas too)
  const { rows: conceptosVenta } = await client.query(
    'SELECT * FROM conceptos_venta WHERE venta_id=$1 ORDER BY id',
    [venta.id]
  );

  let cfdiConceptos;
  if (conceptosVenta.length) {
    cfdiConceptos = conceptosVenta.map(c => ({
      claveProdServ: c.clave_prod_serv,
      cantidad: parseFloat(c.cantidad),
      claveUnidad: c.clave_unidad,
      unidad: c.unidad,
      descripcion: c.descripcion,
      valorUnitario: parseFloat(c.precio_unitario),
      descuento: parseFloat(c.descuento),
      objetoImp: c.objeto_imp,
      tasaIva: parseFloat(c.tasa_iva),
    }));
  } else {
    // Ultimate fallback for pre-migration single-product ventas
    cfdiConceptos = [{
      claveProdServ: '15101514',
      cantidad: parseFloat(venta.litros || 1),
      claveUnidad: 'LTR',
      unidad: 'Litro',
      descripcion: `${venta.tipo_combustible || 'Combustible'} - Folio ${venta.folio_venta}`,
      valorUnitario: parseFloat(venta.precio_unitario || venta.total),
      descuento: 0, objetoImp: '02', tasaIva: 0.16,
    }];
  }

  const { xml } = buildCFDI40({
    empresa: {
      rfc: empresa.rfc,
      nombre: empresa.nombre,
      regimenFiscal: empresa.regimen_fiscal,
      codigoPostal: empresa.codigo_postal,
    },
    cliente: {
      rfc: receptor.rfc,
      nombre: receptor.nombre,
      regimenFiscal: receptor.regimen_fiscal,
      codigoPostal: receptor.codigo_postal,
      usoCfdiDefault: receptor.uso_cfdi || 'S01',
    },
    conceptos: cfdiConceptos,
    opciones: {
      serie: 'V',
      fecha: venta.fecha_venta,
      formaPago: '01',
      metodoPago: 'PUE',
      usoCfdi: receptor.uso_cfdi || 'S01',
      tipoComprobante: 'I',
      exportacion: '01',
      moneda: 'MXN',
      tipoCambio: 1,
    },
  });

  // Resolve or create cliente
  let clienteId = receptor.cliente_id || null;
  if (!clienteId) {
    const { rows: found } = await client.query(
      'SELECT id FROM clientes WHERE empresa_id=$1 AND rfc=$2',
      [empresa.id, receptor.rfc]
    );
    if (found.length) {
      clienteId = found[0].id;
    } else {
      const { rows: newC } = await client.query(
        `INSERT INTO clientes (empresa_id, rfc, nombre, regimen_fiscal, codigo_postal, email, uso_cfdi_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [empresa.id, receptor.rfc, receptor.nombre, receptor.regimen_fiscal,
         receptor.codigo_postal, receptor.email || '', receptor.uso_cfdi || 'S01']
      );
      clienteId = newC[0].id;
    }
  }

  // Series V
  let folioFinal = '1';
  const { rows: serieRows } = await client.query(
    `SELECT * FROM series WHERE empresa_id=$1 AND serie='V' AND tipo_comprobante='I' AND activo=true FOR UPDATE`,
    [empresa.id]
  );
  if (serieRows.length) {
    folioFinal = String(serieRows[0].folio_actual);
    await client.query('UPDATE series SET folio_actual=folio_actual+1 WHERE id=$1', [serieRows[0].id]);
  } else {
    await client.query(
      `INSERT INTO series (empresa_id, serie, tipo_comprobante, folio_actual) VALUES ($1,'V','I',2)`,
      [empresa.id]
    );
  }

  const subtotal = parseFloat(venta.subtotal);
  const ivaImporte = parseFloat(venta.iva);
  const total = parseFloat(venta.total);

  const { rows: facturaRows } = await client.query(
    `INSERT INTO facturas
       (empresa_id, cliente_id, serie, folio, fecha, subtotal, total_impuestos_trasladados,
        total, moneda, tipo_cambio, tipo_comprobante, metodo_pago, forma_pago, uso_cfdi,
        exportacion, lugar_expedicion, xml_cfdi, estado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'MXN',1,'I','PUE','01',$9,'01',$10,$11,'PENDIENTE')
     RETURNING *`,
    [empresa.id, clienteId, 'V', folioFinal, venta.fecha_venta,
     subtotal, ivaImporte, total,
     receptor.uso_cfdi || 'S01', empresa.codigo_postal, xml]
  );
  const factura = facturaRows[0];

  // Insert conceptos_factura from venta conceptos
  for (const c of cfdiConceptos) {
    const imp = parseFloat((c.cantidad * c.valorUnitario - (c.descuento || 0)).toFixed(2));
    const ivaC = parseFloat((imp * c.tasaIva).toFixed(2));
    await client.query(
      `INSERT INTO conceptos_factura
         (factura_id, clave_prod_serv, cantidad, clave_unidad, unidad,
          descripcion, valor_unitario, importe, descuento, objeto_imp, iva_tasa, iva_importe)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [factura.id, c.claveProdServ, c.cantidad, c.claveUnidad, c.unidad,
       c.descripcion, c.valorUnitario, imp, c.descuento || 0, c.objetoImp, c.tasaIva, ivaC]
    );
  }

  return { factura, xml };
}

// ── Helper: execute timbrado and update DB ─────────────────────────────────
async function timbrarYGuardar(factura, xml, ventaId) {
  const timbraResult = await timbrarCFDI(xml);

  if (!timbraResult.xmlTimbrado) {
    const errMsg = `Código ${timbraResult.codigo}: ${timbraResult.mensaje}`;
    await db.query(`UPDATE facturas SET estado='ERROR', error_mensaje=$1 WHERE id=$2`, [errMsg, factura.id]);
    const err = new Error(errMsg);
    err.codigo = timbraResult.codigo;
    err.factura_id = factura.id;
    throw err;
  }

  await db.query(
    `UPDATE facturas SET estado='TIMBRADO', xml_timbrado=$1, uuid=$2, fecha_timbrado=NOW() WHERE id=$3`,
    [timbraResult.xmlTimbrado, timbraResult.uuid, factura.id]
  );
  if (ventaId) {
    await db.query(
      `UPDATE ventas SET estado='FACTURADO', factura_id=$1 WHERE id=$2`,
      [factura.id, ventaId]
    );
  }
  return timbraResult;
}

// ── Router ─────────────────────────────────────────────────────────────────
const router = express.Router();

// ── PUBLIC routes (no JWT) ─────────────────────────────────────────────────

router.get('/public/venta/:folio', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT v.folio_venta, v.subtotal, v.iva, v.total, v.estado, v.estacion, v.fecha_venta,
              COALESCE(
                (SELECT descripcion FROM conceptos_venta WHERE venta_id=v.id ORDER BY id LIMIT 1),
                v.tipo_combustible
              ) as descripcion_principal,
              (SELECT COUNT(*) FROM conceptos_venta WHERE venta_id=v.id) as num_conceptos
       FROM ventas v WHERE v.folio_venta = $1`,
      [req.params.folio]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Venta no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/public/facturar', async (req, res) => {
  const { folio_venta, rfc_receptor, nombre_receptor, regimen_fiscal, codigo_postal, uso_cfdi, email } = req.body;

  if (!folio_venta || !rfc_receptor || !nombre_receptor || !regimen_fiscal || !codigo_postal) {
    return res.status(400).json({
      error: 'folio_venta, rfc_receptor, nombre_receptor, regimen_fiscal y codigo_postal son requeridos',
    });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ventas } = await client.query(
      'SELECT * FROM ventas WHERE folio_venta=$1 FOR UPDATE', [folio_venta]
    );
    if (!ventas[0]) return res.status(404).json({ error: 'Venta no encontrada' });
    const venta = ventas[0];

    if (venta.estado !== 'PENDIENTE') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `No se puede facturar: la venta está en estado ${venta.estado}`, estado: venta.estado });
    }

    const { rows: empresas } = await client.query('SELECT * FROM empresas WHERE id=$1', [venta.empresa_id]);
    if (!empresas[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Empresa no encontrada' }); }

    const receptor = {
      rfc: rfc_receptor.trim().toUpperCase(), nombre: nombre_receptor.trim(),
      regimen_fiscal: regimen_fiscal.trim(), codigo_postal: codigo_postal.trim(),
      uso_cfdi: uso_cfdi || 'S01', email: email || '',
    };

    const { factura, xml } = await crearFacturaDesdeVenta(client, venta, receptor, empresas[0]);
    await client.query('COMMIT');

    const timbraResult = await timbrarYGuardar(factura, xml, venta.id);
    res.status(201).json({ folio_venta, factura_id: factura.id, uuid: timbraResult.uuid, estado: 'FACTURADO', total: parseFloat(venta.total) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(err.factura_id ? 422 : 500).json({ error: err.message, factura_id: err.factura_id });
  } finally {
    client.release();
  }
});

// ── Authenticated routes ───────────────────────────────────────────────────
router.use(auth);

// GET / — list ventas with summary of first concept
router.get('/', async (req, res) => {
  const { empresa_id, estado, desde, hasta, limit = 50, offset = 0 } = req.query;
  try {
    let sql = `
      SELECT v.id, v.folio_venta, v.fecha_venta, v.subtotal, v.iva, v.total,
             v.referencia, v.placa, v.estacion, v.bomba, v.estado,
             v.factura_id, f.uuid as factura_uuid, f.serie as factura_serie, f.folio as factura_folio,
             COALESCE(
               (SELECT descripcion FROM conceptos_venta WHERE venta_id=v.id ORDER BY id LIMIT 1),
               v.tipo_combustible
             ) as concepto_desc,
             (SELECT COUNT(*) FROM conceptos_venta WHERE venta_id=v.id)::int as num_conceptos
      FROM ventas v
      LEFT JOIN facturas f ON v.factura_id = f.id
      WHERE 1=1
    `;
    const params = [];
    if (empresa_id) { params.push(empresa_id); sql += ` AND v.empresa_id=$${params.length}`; }
    if (estado) { params.push(estado); sql += ` AND v.estado=$${params.length}`; }
    if (desde) { params.push(desde); sql += ` AND v.fecha_venta >= $${params.length}`; }
    if (hasta) { params.push(hasta); sql += ` AND v.fecha_venta <= $${params.length}`; }
    sql += ` ORDER BY v.fecha_venta DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / — create venta (multiproduct: conceptos[] required)
router.post('/', async (req, res) => {
  const { empresa_id, folio_venta, fecha_venta, referencia, placa, estacion, bomba, conceptos } = req.body;

  if (!empresa_id || !folio_venta) {
    return res.status(400).json({ error: 'empresa_id y folio_venta son requeridos' });
  }
  if (!Array.isArray(conceptos) || conceptos.length === 0) {
    return res.status(400).json({ error: 'Se requiere al menos un concepto en el array conceptos[]' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Resolve product catalog data for each concepto
    const conceptosResueltos = [];
    for (const c of conceptos) {
      let row = { ...c };
      if (c.producto_id) {
        const { rows: prod } = await client.query(
          'SELECT * FROM productos WHERE id=$1 AND empresa_id=$2',
          [c.producto_id, empresa_id]
        );
        if (prod[0]) {
          row = {
            producto_id: prod[0].id,
            clave_prod_serv: c.clave_prod_serv || prod[0].clave_prod_serv,
            clave_unidad: c.clave_unidad || prod[0].clave_unidad,
            unidad: c.unidad || prod[0].unidad,
            descripcion: c.descripcion || prod[0].descripcion,
            cantidad: parseFloat(c.cantidad),
            precio_unitario: parseFloat(c.precio_unitario ?? prod[0].precio_unitario),
            tasa_iva: parseFloat(c.tasa_iva ?? prod[0].tasa_iva ?? 0.16),
            objeto_imp: c.objeto_imp || prod[0].objeto_imp || '02',
          };
        }
      }
      const cant = parseFloat(row.cantidad);
      const precio = parseFloat(row.precio_unitario);
      const desc = parseFloat(row.descuento || 0);
      if (!cant || !precio) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Concepto inválido: cantidad y precio_unitario requeridos`, concepto: row.descripcion });
      }
      const subtotalC = parseFloat((cant * precio - desc).toFixed(2));
      const tasaIva = parseFloat(row.tasa_iva ?? 0.16);
      const ivaImporte = parseFloat((subtotalC * tasaIva).toFixed(2));
      conceptosResueltos.push({
        producto_id: row.producto_id || null,
        clave_prod_serv: row.clave_prod_serv || '01010101',
        clave_unidad: row.clave_unidad || 'E48',
        unidad: row.unidad || 'Servicio',
        descripcion: (row.descripcion || '').trim(),
        cantidad: cant, precio_unitario: precio, descuento: desc,
        subtotal: subtotalC, objeto_imp: row.objeto_imp || '02',
        tasa_iva: tasaIva, iva_importe: ivaImporte,
      });
    }

    const subtotal = parseFloat(conceptosResueltos.reduce((s, c) => s + c.subtotal, 0).toFixed(2));
    const iva = parseFloat(conceptosResueltos.reduce((s, c) => s + c.iva_importe, 0).toFixed(2));
    const total = parseFloat((subtotal + iva).toFixed(2));

    const { rows: ventaRows } = await client.query(
      `INSERT INTO ventas (empresa_id, folio_venta, fecha_venta, estacion, bomba,
         referencia, placa, subtotal, iva, total, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDIENTE') RETURNING *`,
      [empresa_id, folio_venta, fecha_venta || new Date(),
       estacion || null, bomba || null,
       referencia || placa || null, placa || null,
       subtotal, iva, total]
    );
    const venta = ventaRows[0];

    for (const c of conceptosResueltos) {
      await client.query(
        `INSERT INTO conceptos_venta
           (venta_id, producto_id, clave_prod_serv, clave_unidad, unidad, descripcion,
            cantidad, precio_unitario, descuento, subtotal, objeto_imp, tasa_iva, iva_importe)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [venta.id, c.producto_id, c.clave_prod_serv, c.clave_unidad, c.unidad,
         c.descripcion, c.cantidad, c.precio_unitario, c.descuento,
         c.subtotal, c.objeto_imp, c.tasa_iva, c.iva_importe]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ...venta, conceptos: conceptosResueltos });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: `El folio ${folio_venta} ya existe` });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /:id — detail with conceptos
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT v.*, f.uuid as factura_uuid, f.serie as factura_serie, f.folio as factura_folio
       FROM ventas v
       LEFT JOIN facturas f ON v.factura_id = f.id
       WHERE v.id=$1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Venta no encontrada' });
    const { rows: conceptos } = await db.query(
      'SELECT * FROM conceptos_venta WHERE venta_id=$1 ORDER BY id',
      [req.params.id]
    );
    res.json({ ...rows[0], conceptos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /:id — update metadata fields only
router.put('/:id', async (req, res) => {
  const { placa, estado, bomba, estacion, referencia } = req.body;
  try {
    const { rows: current } = await db.query('SELECT * FROM ventas WHERE id=$1', [req.params.id]);
    if (!current[0]) return res.status(404).json({ error: 'Venta no encontrada' });
    const { rows } = await db.query(
      `UPDATE ventas SET
         placa      = COALESCE($1, placa),
         estado     = COALESCE($2, estado),
         bomba      = COALESCE($3, bomba),
         estacion   = COALESCE($4, estacion),
         referencia = COALESCE($5, referencia)
       WHERE id=$6 RETURNING *`,
      [placa ?? null, estado ?? null, bomba ?? null, estacion ?? null, referencia ?? null, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/facturar — invoice from platform UI
router.post('/:id/facturar', async (req, res) => {
  const {
    rfc_receptor = 'XAXX010101000', nombre_receptor = 'PUBLICO EN GENERAL',
    regimen_fiscal = '616', codigo_postal = '01030', uso_cfdi = 'S01', email = '',
  } = req.body || {};

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ventas } = await client.query('SELECT * FROM ventas WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!ventas[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Venta no encontrada' }); }
    const venta = ventas[0];

    if (venta.estado !== 'PENDIENTE') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `No se puede facturar: la venta está en estado ${venta.estado}`, estado: venta.estado });
    }

    const { rows: empresas } = await client.query('SELECT * FROM empresas WHERE id=$1', [venta.empresa_id]);
    if (!empresas[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Empresa no encontrada' }); }

    const receptor = {
      rfc: rfc_receptor.trim().toUpperCase(), nombre: nombre_receptor.trim(),
      regimen_fiscal: regimen_fiscal.trim(), codigo_postal: codigo_postal.trim(),
      uso_cfdi: uso_cfdi || 'S01', email: email || '',
    };

    const { factura, xml } = await crearFacturaDesdeVenta(client, venta, receptor, empresas[0]);
    await client.query('COMMIT');

    const timbraResult = await timbrarYGuardar(factura, xml, venta.id);
    res.status(201).json({
      venta_id: parseInt(req.params.id), factura_id: factura.id,
      uuid: timbraResult.uuid, estado: 'FACTURADO',
      total: parseFloat(venta.total), xml: timbraResult.xmlTimbrado,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(err.factura_id ? 422 : 500).json({
      error: err.message, codigo: err.codigo, factura_id: err.factura_id,
    });
  } finally {
    client.release();
  }
});

// POST /importar — bulk import (single-product, backward compat)
router.post('/importar', async (req, res) => {
  let registros = req.body;

  if (!registros || (Array.isArray(registros) && registros.length === 0)) {
    const jsonPath = path.join(__dirname, '../../../../ventas.json');
    if (!fs.existsSync(jsonPath)) return res.status(400).json({ error: 'No hay datos en el body ni en ventas.json' });
    try {
      const raw = fs.readFileSync(jsonPath, 'utf8').trim();
      if (!raw) return res.status(400).json({ error: 'ventas.json está vacío' });
      registros = JSON.parse(raw);
    } catch (e) {
      return res.status(400).json({ error: 'ventas.json tiene formato inválido: ' + e.message });
    }
  }

  if (!Array.isArray(registros)) registros = [registros];

  const empresa_id = req.query.empresa_id || 1;
  const resultados = { importados: 0, omitidos: 0, errores: [] };

  for (const r of registros) {
    const client = await db.pool.connect();
    try {
      const litros = parseFloat(r.litros ?? r.cantidad ?? 0);
      const precioUnit = parseFloat(r.precio_unitario ?? r.precio ?? r.precioUnitario ?? 0);
      const subtotal = r.subtotal != null ? parseFloat(r.subtotal) : parseFloat((litros * precioUnit).toFixed(2));
      const iva = r.iva != null ? parseFloat(r.iva) : parseFloat((subtotal * 0.16).toFixed(2));
      const total = r.total != null ? parseFloat(r.total) : parseFloat((subtotal + iva).toFixed(2));
      const folio = r.folio_venta ?? r.folio ?? r.ticket ?? r.id ?? null;

      if (!folio) { resultados.errores.push({ registro: r, error: 'Sin folio' }); resultados.omitidos++; client.release(); continue; }

      const tipo = r.tipo_combustible ?? r.tipo ?? r.combustible ?? r.product ?? 'Magna';
      const descripcion = `${tipo} - Folio ${folio}`;

      await client.query('BEGIN');
      const { rows: inserted } = await client.query(
        `INSERT INTO ventas (empresa_id, folio_venta, fecha_venta, estacion, bomba,
           tipo_combustible, litros, precio_unitario, subtotal, iva, total, placa, estado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDIENTE')
         ON CONFLICT (folio_venta) DO NOTHING RETURNING id`,
        [empresa_id, String(folio), r.fecha_venta ?? r.fecha ?? r.date ?? new Date(),
         r.estacion ?? r.station ?? null, r.bomba ?? r.pump ?? null,
         tipo, litros, precioUnit, subtotal, iva, total, r.placa ?? r.plate ?? null]
      );

      if (inserted[0]) {
        await client.query(
          `INSERT INTO conceptos_venta
             (venta_id, clave_prod_serv, clave_unidad, unidad, descripcion,
              cantidad, precio_unitario, descuento, subtotal, objeto_imp, tasa_iva, iva_importe)
           VALUES ($1,'15101514','LTR','Litro',$2,$3,$4,0,$5,'02',0.160,$6)`,
          [inserted[0].id, descripcion, litros, precioUnit, subtotal, iva]
        );
        resultados.importados++;
      } else {
        resultados.omitidos++;
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      resultados.errores.push({ folio: r.folio_venta ?? r.folio, error: e.message });
      resultados.omitidos++;
    } finally {
      client.release();
    }
  }

  res.json({ ...resultados, total: registros.length });
});

module.exports = router;
