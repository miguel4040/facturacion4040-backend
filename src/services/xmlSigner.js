'use strict';

/**
 * Firmado de CFDI 4.0 con CSD (Certificado de Sello Digital) usando node-forge.
 *
 * Proceso:
 *  1. Lee el .cer (DER) → NoCertificado + Certificado (base64)
 *  2. Lee el .key (PKCS#8 encriptado DER) → llave privada RSA
 *  3. Construye la cadena original del CFDI
 *  4. Firma con SHA-256 + RSA-PKCS1v15 → Sello (base64)
 *  5. Inyecta Sello, NoCertificado, Certificado en el XML
 */

const forge = require('node-forge');
const fs = require('fs');

/** Convierte un Buffer a string binario para node-forge */
function bufferToBinary(buf) {
  let binary = '';
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return binary;
}

/**
 * Carga un certificado .cer (DER) y retorna su número y base64.
 */
function loadCertificate(cerPath) {
  const derBuffer = fs.readFileSync(cerPath);
  const derBinary = bufferToBinary(derBuffer);

  // node-forge: DER → ASN.1 → Certificate
  const asn1 = forge.asn1.fromDer(derBinary);
  const cert = forge.pki.certificateFromAsn1(asn1);

  // NoCertificado: el SAT codifica el serial como bytes ASCII del número decimal
  const serialDec = Buffer.from(cert.serialNumber, 'hex').toString('ascii').replace(/\x00/g, '');

  // Certificado: base64 del DER sin saltos de línea
  const certB64 = derBuffer.toString('base64').replace(/\n/g, '');

  return { cert, noCertificado: serialDec, certificadoB64: certB64 };
}

/**
 * Carga una llave privada .key (PKCS#8 encriptado DER) del SAT.
 * El .key del SAT es un PKCS#8 EncryptedPrivateKeyInfo en formato DER.
 * Estrategia: envolver en PEM y usar forge.pki.decryptRsaPrivateKey.
 */
function loadPrivateKey(keyPath, password) {
  const keyBuffer = fs.readFileSync(keyPath);

  // Convertir DER a PEM (ENCRYPTED PRIVATE KEY)
  const b64 = keyBuffer.toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  const pem = `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${lines}\n-----END ENCRYPTED PRIVATE KEY-----\n`;

  const privateKey = forge.pki.decryptRsaPrivateKey(pem, password);

  if (!privateKey) {
    throw new Error('No se pudo descifrar la llave privada. Verifica la contraseña (default: 12345678a).');
  }
  return privateKey;
}

/**
 * Genera la cadena original de un CFDI 4.0 según el XSLT del SAT.
 * Solo incluye atributos con valor (los vacíos se omiten).
 */
function buildCadenaOriginal(cfdiData) {
  const { comprobante, emisor, receptor, conceptos, impuestos } = cfdiData;

  const fields = [];

  // Comprobante
  const c = comprobante;
  const add = v => { if (v !== null && v !== undefined && v !== '') fields.push(v); };

  add(c.Version);
  add(c.Serie);
  add(c.Folio);
  add(c.Fecha);
  add(c.FormaPago);
  add(c.NoCertificado);
  add(c.SubTotal);
  add(c.Descuento);
  add(c.Moneda);
  add(c.TipoCambio);
  add(c.Total);
  add(c.TipoDeComprobante);
  add(c.Exportacion);
  add(c.MetodoPago);
  add(c.LugarExpedicion);
  add(c.CondicionesDePago);

  // InformacionGlobal (si existe)
  const { informacionGlobal } = cfdiData;
  if (informacionGlobal) {
    add(informacionGlobal.Periodicidad);
    add(informacionGlobal.Meses);
    add(informacionGlobal.Año);
  }

  // Emisor
  add(emisor.Rfc);
  add(emisor.Nombre);
  add(emisor.RegimenFiscal);

  // Receptor
  add(receptor.Rfc);
  add(receptor.Nombre);
  add(receptor.ResidenciaFiscal);
  add(receptor.NumRegIdTrib);
  add(receptor.DomicilioFiscalReceptor);
  add(receptor.RegimenFiscalReceptor);
  add(receptor.UsoCFDI);

  // Conceptos
  for (const con of conceptos) {
    add(con.ClaveProdServ);
    add(con.NoIdentificacion);
    add(con.Cantidad);
    add(con.ClaveUnidad);
    add(con.Unidad);
    add(con.Descripcion);
    add(con.ValorUnitario);
    add(con.Importe);
    add(con.Descuento);
    add(con.ObjetoImp);

    for (const t of (con.Traslados || [])) {
      add(t.Base);
      add(t.Impuesto);
      add(t.TipoFactor);
      add(t.TasaOCuota);
      add(t.Importe);
    }

    for (const r of (con.Retenciones || [])) {
      add(r.Base);
      add(r.Impuesto);
      add(r.TipoFactor);
      add(r.TasaOCuota);
      add(r.Importe);
    }
  }

  // Impuestos totales (children first, then totals — per SAT CFDI 4.0 XSLT)
  if (impuestos) {
    for (const r of (impuestos.Retenciones || [])) {
      add(r.Base);
      add(r.Impuesto);
      add(r.TipoFactor);
      add(r.TasaOCuota);
      add(r.Importe);
    }

    for (const t of (impuestos.Traslados || [])) {
      add(t.Base);
      add(t.Impuesto);
      add(t.TipoFactor);
      add(t.TasaOCuota);
      add(t.Importe);
    }

    add(impuestos.TotalImpuestosRetenidos);
    add(impuestos.TotalImpuestosTrasladados);
  }

  return '||' + fields.join('|') + '||';
}

/**
 * Firma la cadena original con SHA-256 + RSA-PKCS1v15.
 * Retorna el sello en base64.
 */
function sign(cadenaOriginal, privateKey) {
  const md = forge.md.sha256.create();
  md.update(cadenaOriginal, 'utf8');
  const signature = privateKey.sign(md);
  return forge.util.encode64(signature);
}

/**
 * Inyecta Sello, NoCertificado y Certificado en el XML del CFDI.
 */
function injectSignature(xml, sello, noCertificado, certificado) {
  return xml
    .replace(/Sello=""/, `Sello="${sello}"`)
    .replace(/NoCertificado=""/, `NoCertificado="${noCertificado}"`)
    .replace(/Certificado=""/, `Certificado="${certificado}"`);
}

/**
 * Firma completo: dado el XML sin sello y los paths del CSD, retorna el XML firmado.
 */
function signCFDI(xml, cerPath, keyPath, keyPassword) {
  const { noCertificado, certificadoB64 } = loadCertificate(cerPath);
  const privateKey = loadPrivateKey(keyPath, keyPassword);

  // Construir datos para cadena original parseando el XML
  const cfdiData = parseCFDIForCadena(xml, noCertificado, certificadoB64);
  const cadena = buildCadenaOriginal(cfdiData);

  console.log('[FIRMA] Cadena original COMPLETA:', cadena);

  const sello = sign(cadena, privateKey);
  const signedXml = injectSignature(xml, sello, noCertificado, certificadoB64);

  return { signedXml, cadena, sello, noCertificado, certificadoB64 };
}

/**
 * Parsea el XML generado y extrae los datos en la estructura que
 * necesita buildCadenaOriginal. Esto funciona porque conocemos exactamente
 * el formato que genera xmlBuilder.js.
 */
function parseCFDIForCadena(xml, noCertificado, certificadoB64) {
  const attr = (tag, name) => {
    const re = new RegExp(`${name}="([^"]*)"`, 'i');
    const section = xml.slice(xml.indexOf(tag));
    const m = section.match(re);
    return m ? m[1] : null;
  };

  const getVal = (name) => {
    const re = new RegExp(`\\s${name}="([^"]*)"`, 'i');
    const lineEnd = xml.indexOf('>');
    const header = xml.substring(0, lineEnd + 500);
    const m = header.match(re);
    return m ? m[1] : null;
  };

  // Extraer atributos del Comprobante (desde <cfdi:Comprobante hasta <cfdi:Emisor)
  const compAttr = (name) => {
    const startIdx = xml.indexOf('<cfdi:Comprobante');
    const endIdx = xml.indexOf('<cfdi:Emisor');
    const cfdiBlock = xml.substring(startIdx, endIdx);
    const re = new RegExp(`\\b${name}="([^"]*)"`, 'i');
    const m = cfdiBlock.match(re);
    return m ? m[1] || null : null;
  };

  // InformacionGlobal (opcional)
  const igBlockRaw = xml.match(/<cfdi:InformacionGlobal([^/]*)\//)?.[1] || '';
  const igAttr = (name) => {
    const re = new RegExp(`\\b${name}="([^"]*)"`, 'i');
    const m = igBlockRaw.match(re);
    return m ? m[1] || null : null;
  };
  const informacionGlobal = igBlockRaw ? {
    Periodicidad: igAttr('Periodicidad'),
    Meses: igAttr('Meses'),
    Año: igAttr('Año') || igAttr('Ano'),
  } : null;

  const emisorBlock = xml.match(/<cfdi:Emisor([^/]*)\//)?.[1] || '';
  const receptorBlock = xml.match(/<cfdi:Receptor([^/]*)\//)?.[1] || '';

  const eAttr = (name) => {
    const re = new RegExp(`\\b${name}="([^"]*)"`, 'i');
    const m = emisorBlock.match(re);
    return m ? m[1] || null : null;
  };
  const rAttr = (name) => {
    const re = new RegExp(`\\b${name}="([^"]*)"`, 'i');
    const m = receptorBlock.match(re);
    return m ? m[1] || null : null;
  };

  // Conceptos
  const conceptos = [];
  const conceptoRegex = /<cfdi:Concepto([\s\S]*?)(?=<\/cfdi:Concepto>|<cfdi:Concepto)/g;
  let match;
  while ((match = conceptoRegex.exec(xml)) !== null) {
    const block = match[1];
    const cAttr = (name) => {
      const re = new RegExp(`\\b${name}="([^"]*)"`, 'i');
      const m = block.match(re);
      return m ? m[1] || null : null;
    };

    const traslados = [];
    const trasladoRegex = /<cfdi:Traslado([\s\S]*?)\/>/g;
    // Solo traslados dentro de este concepto (antes del siguiente Concepto o cierre de Impuestos)
    const impBlock = block.match(/<cfdi:Impuestos>([\s\S]*?)<\/cfdi:Impuestos>/)?.[1] || '';
    const trasMatch = impBlock.match(/<cfdi:Traslados>([\s\S]*?)<\/cfdi:Traslados>/)?.[1] || '';

    const singleTrasRe = /<cfdi:Traslado([^/]*)\//g;
    let tm;
    while ((tm = singleTrasRe.exec(trasMatch)) !== null) {
      const tb = tm[1];
      const tAttr = (n) => { const re = new RegExp(`\\b${n}="([^"]*)"`, 'i'); const m = tb.match(re); return m ? m[1] || null : null; };
      traslados.push({
        Base: tAttr('Base'), Impuesto: tAttr('Impuesto'),
        TipoFactor: tAttr('TipoFactor'), TasaOCuota: tAttr('TasaOCuota'),
        Importe: tAttr('Importe'),
      });
    }

    conceptos.push({
      ClaveProdServ: cAttr('ClaveProdServ'),
      NoIdentificacion: cAttr('NoIdentificacion'),
      Cantidad: cAttr('Cantidad'),
      ClaveUnidad: cAttr('ClaveUnidad'),
      Unidad: cAttr('Unidad'),
      Descripcion: cAttr('Descripcion'),
      ValorUnitario: cAttr('ValorUnitario'),
      Importe: cAttr('Importe'),
      Descuento: cAttr('Descuento'),
      ObjetoImp: cAttr('ObjetoImp'),
      Traslados: traslados,
      Retenciones: [],
    });
  }

  // Impuestos totales (elemento hijo directo de Comprobante, después de Conceptos)
  const afterConceptos = xml.substring(xml.indexOf('</cfdi:Conceptos>'));
  const impTotBlock = afterConceptos.match(/<cfdi:Impuestos([^>]*)>/)?.[1] || '';
  const impTotAttr = (name) => { const re = new RegExp(`\\b${name}="([^"]*)"`, 'i'); const m = impTotBlock.match(re); return m ? m[1] || null : null; };

  const totTrasladosBlock = afterConceptos.match(/<cfdi:Traslados>([\s\S]*?)<\/cfdi:Traslados>/)?.[1] || '';
  const totTraslados = [];
  const totRe = /<cfdi:Traslado([^/]*)\//g;
  let ttm;
  while ((ttm = totRe.exec(totTrasladosBlock)) !== null) {
    const tb = ttm[1];
    const tAttr = (n) => { const re = new RegExp(`\\b${n}="([^"]*)"`, 'i'); const m = tb.match(re); return m ? m[1] || null : null; };
    totTraslados.push({
      Base: tAttr('Base'), Impuesto: tAttr('Impuesto'),
      TipoFactor: tAttr('TipoFactor'), TasaOCuota: tAttr('TasaOCuota'),
      Importe: tAttr('Importe'),
    });
  }

  return {
    comprobante: {
      Version: compAttr('Version'),
      Serie: compAttr('Serie'),
      Folio: compAttr('Folio'),
      Fecha: compAttr('Fecha'),
      FormaPago: compAttr('FormaPago'),
      NoCertificado: noCertificado,
      Certificado: certificadoB64,
      SubTotal: compAttr('SubTotal'),
      Descuento: compAttr('Descuento'),
      Moneda: compAttr('Moneda'),
      TipoCambio: compAttr('TipoCambio'),
      Total: compAttr('Total'),
      TipoDeComprobante: compAttr('TipoDeComprobante'),
      Exportacion: compAttr('Exportacion'),
      MetodoPago: compAttr('MetodoPago'),
      LugarExpedicion: compAttr('LugarExpedicion'),
      CondicionesDePago: compAttr('CondicionesDePago'),
    },
    emisor: {
      Rfc: eAttr('Rfc'),
      Nombre: eAttr('Nombre'),
      RegimenFiscal: eAttr('RegimenFiscal'),
    },
    receptor: {
      Rfc: rAttr('Rfc'),
      Nombre: rAttr('Nombre'),
      ResidenciaFiscal: rAttr('ResidenciaFiscal'),
      NumRegIdTrib: rAttr('NumRegIdTrib'),
      DomicilioFiscalReceptor: rAttr('DomicilioFiscalReceptor'),
      RegimenFiscalReceptor: rAttr('RegimenFiscalReceptor'),
      UsoCFDI: rAttr('UsoCFDI'),
    },
    conceptos,
    informacionGlobal,
    impuestos: {
      TotalImpuestosRetenidos: impTotAttr('TotalImpuestosRetenidos'),
      TotalImpuestosTrasladados: impTotAttr('TotalImpuestosTrasladados'),
      Traslados: totTraslados,
      Retenciones: [],
    },
  };
}

module.exports = { signCFDI, loadCertificate, buildCadenaOriginal };
