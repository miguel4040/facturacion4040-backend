'use strict';

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatMonto(num) {
  return parseFloat(num || 0).toFixed(2);
}

function formatCantidad(num) {
  const n = parseFloat(num || 0);
  return n % 1 === 0 ? n.toFixed(0) : n.toString();
}

function formatTasa(num) {
  return parseFloat(num || 0).toFixed(6);
}

function formatDate(d) {
  const date = d ? new Date(d) : new Date();
  // SAT requires Fecha in Mexico City local time (UTC-6 CST / UTC-5 CDT)
  const offsetMs = -6 * 60 * 60 * 1000; // CST UTC-6
  const mx = new Date(date.getTime() + offsetMs);
  return mx.toISOString().slice(0, 19);
}

/**
 * Builds a CFDI 4.0 XML string (sin sello) ready for the timbrado service.
 *
 * @param {Object} data
 * @param {Object} data.empresa - Issuer info
 * @param {Object} data.cliente - Recipient info
 * @param {Array}  data.conceptos - Line items
 * @param {Object} data.opciones - Invoice options (serie, folio, fecha, etc.)
 * @returns {string} XML string
 */
function buildCFDI40(data) {
  const { empresa, cliente, conceptos, opciones = {} } = data;

  // Calcular totales
  let subtotal = 0;
  let totalIva = 0;

  const conceptosCalc = conceptos.map(c => {
    const importe = parseFloat((c.cantidad * c.valorUnitario).toFixed(2));
    const descuento = parseFloat(c.descuento || 0);
    const base = importe - descuento;
    const ivaImporte = c.objetoImp === '02'
      ? parseFloat((base * (c.tasaIva !== undefined ? c.tasaIva : 0.16)).toFixed(2))
      : 0;
    subtotal += base;
    totalIva += ivaImporte;
    return { ...c, importe: base, descuento, ivaImporte, base };
  });

  const total = parseFloat((subtotal + totalIva).toFixed(2));
  const fecha = formatDate(opciones.fecha);
  const tipoComprobante = opciones.tipoComprobante || 'I';
  const moneda = opciones.moneda || 'MXN';

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<cfdi:Comprobante\n`;
  xml += `  xmlns:cfdi="http://www.sat.gob.mx/cfd/4"\n`;
  xml += `  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n`;
  xml += `  xsi:schemaLocation="http://www.sat.gob.mx/cfd/4 http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd"\n`;
  xml += `  Version="4.0"\n`;
  if (opciones.serie) xml += `  Serie="${escapeXml(opciones.serie)}"\n`;
  if (opciones.folio) xml += `  Folio="${escapeXml(opciones.folio)}"\n`;
  xml += `  Fecha="${fecha}"\n`;
  xml += `  Sello=""\n`;
  if (opciones.formaPago && tipoComprobante !== 'P') xml += `  FormaPago="${opciones.formaPago}"\n`;
  xml += `  NoCertificado=""\n`;
  xml += `  Certificado=""\n`;
  xml += `  SubTotal="${formatMonto(subtotal)}"\n`;
  if (parseFloat(opciones.descuento || 0) > 0) xml += `  Descuento="${formatMonto(opciones.descuento)}"\n`;
  xml += `  Moneda="${moneda}"\n`;
  if (moneda !== 'MXN' && opciones.tipoCambio) xml += `  TipoCambio="${parseFloat(opciones.tipoCambio).toFixed(4)}"\n`;
  xml += `  Total="${formatMonto(total)}"\n`;
  xml += `  TipoDeComprobante="${tipoComprobante}"\n`;
  xml += `  Exportacion="${opciones.exportacion || '01'}"\n`;
  if (opciones.metodoPago && tipoComprobante !== 'P') xml += `  MetodoPago="${opciones.metodoPago}"\n`;
  xml += `  LugarExpedicion="${empresa.codigoPostal}"`;
  if (opciones.condicionesDePago) xml += `\n  CondicionesDePago="${escapeXml(opciones.condicionesDePago)}"`;
  xml += `>\n`;

  // InformacionGlobal: requerido cuando receptor es XAXX010101000 (Público en General)
  if (cliente.rfc === 'XAXX010101000') {
    const fechaObj = new Date(fecha);
    const mes = String(fechaObj.getMonth() + 1).padStart(2, '0');
    const anio = String(fechaObj.getFullYear());
    xml += `  <cfdi:InformacionGlobal\n`;
    xml += `    Periodicidad="04"\n`;
    xml += `    Meses="${mes}"\n`;
    xml += `    Año="${anio}"/>\n`;
  }

  // Emisor
  xml += `  <cfdi:Emisor\n`;
  xml += `    Rfc="${empresa.rfc}"\n`;
  xml += `    Nombre="${escapeXml(empresa.nombre)}"\n`;
  xml += `    RegimenFiscal="${empresa.regimenFiscal}"/>\n`;

  // Receptor
  xml += `  <cfdi:Receptor\n`;
  xml += `    Rfc="${cliente.rfc}"\n`;
  xml += `    Nombre="${escapeXml(cliente.nombre)}"\n`;
  xml += `    DomicilioFiscalReceptor="${cliente.codigoPostal}"\n`;
  xml += `    RegimenFiscalReceptor="${cliente.regimenFiscal}"\n`;
  xml += `    UsoCFDI="${opciones.usoCfdi || cliente.usoCfdiDefault || 'G03'}"/>\n`;

  // Conceptos
  xml += `  <cfdi:Conceptos>\n`;
  for (const c of conceptosCalc) {
    xml += `    <cfdi:Concepto\n`;
    xml += `      ClaveProdServ="${c.claveProdServ || '01010101'}"\n`;
    if (c.noIdentificacion) xml += `      NoIdentificacion="${escapeXml(c.noIdentificacion)}"\n`;
    xml += `      Cantidad="${formatCantidad(c.cantidad)}"\n`;
    xml += `      ClaveUnidad="${c.claveUnidad || 'E48'}"\n`;
    if (c.unidad) xml += `      Unidad="${escapeXml(c.unidad)}"\n`;
    xml += `      Descripcion="${escapeXml(c.descripcion)}"\n`;
    xml += `      ValorUnitario="${parseFloat(c.valorUnitario).toFixed(6)}"\n`;
    xml += `      Importe="${formatMonto(c.importe)}"\n`;
    if (c.descuento > 0) xml += `      Descuento="${formatMonto(c.descuento)}"\n`;
    xml += `      ObjetoImp="${c.objetoImp || '02'}"`;

    if (c.objetoImp === '02' && c.ivaImporte > 0) {
      const tasaIva = c.tasaIva !== undefined ? c.tasaIva : 0.16;
      xml += `>\n`;
      xml += `      <cfdi:Impuestos>\n`;
      xml += `        <cfdi:Traslados>\n`;
      xml += `          <cfdi:Traslado\n`;
      xml += `            Base="${formatMonto(c.base)}"\n`;
      xml += `            Impuesto="002"\n`;
      xml += `            TipoFactor="Tasa"\n`;
      xml += `            TasaOCuota="${formatTasa(tasaIva)}"\n`;
      xml += `            Importe="${formatMonto(c.ivaImporte)}"/>\n`;
      xml += `        </cfdi:Traslados>\n`;
      xml += `      </cfdi:Impuestos>\n`;
      xml += `    </cfdi:Concepto>\n`;
    } else {
      xml += `/>\n`;
    }
  }
  xml += `  </cfdi:Conceptos>\n`;

  // Totales de impuestos
  if (totalIva > 0) {
    xml += `  <cfdi:Impuestos TotalImpuestosTrasladados="${formatMonto(totalIva)}">\n`;
    xml += `    <cfdi:Traslados>\n`;

    // Agrupar por tasa
    const grupos = {};
    for (const c of conceptosCalc) {
      if (c.objetoImp !== '02' || c.ivaImporte <= 0) continue;
      const tasa = formatTasa(c.tasaIva !== undefined ? c.tasaIva : 0.16);
      if (!grupos[tasa]) grupos[tasa] = { base: 0, importe: 0, tasa: c.tasaIva !== undefined ? c.tasaIva : 0.16 };
      grupos[tasa].base += c.base;
      grupos[tasa].importe += c.ivaImporte;
    }

    for (const tasa of Object.keys(grupos)) {
      const g = grupos[tasa];
      xml += `      <cfdi:Traslado\n`;
      xml += `        Base="${formatMonto(g.base)}"\n`;
      xml += `        Impuesto="002"\n`;
      xml += `        TipoFactor="Tasa"\n`;
      xml += `        TasaOCuota="${tasa}"\n`;
      xml += `        Importe="${formatMonto(g.importe)}"/>\n`;
    }

    xml += `    </cfdi:Traslados>\n`;
    xml += `  </cfdi:Impuestos>\n`;
  }

  xml += `</cfdi:Comprobante>`;

  return { xml, subtotal, totalIva, total };
}

module.exports = { buildCFDI40, escapeXml, formatMonto, formatDate };
