// netlify/functions/migrar.js
exports.handler = async (event) => {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return { statusCode: 500, body: JSON.stringify({ error: 'Token no configurado' }) };

    const owner = 'fherross3-ops';
    const repo = 'JTX-Reporte';
    const branch = 'main';
    const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents`;

    // ?force=1 → reemplaza JSONs existentes (para regenerar los migrados con datos viejos)
    const force = (event.queryStringParameters && event.queryStringParameters.force === '1');

    async function listFiles(path) {
      const res = await fetch(`${apiBase}/${path}?ref=${branch}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
      });
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`List ${path} → ${res.status}`);
      return res.json();
    }

    async function getFileContent(path) {
      const res = await fetch(`${apiBase}/${path}?ref=${branch}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Buffer.from(data.content, 'base64').toString('utf8');
    }

    async function putFileContent(path, content, message) {
      let sha = null;
      try {
        const checkRes = await fetch(`${apiBase}/${path}?ref=${branch}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
        });
        if (checkRes.ok) sha = (await checkRes.json()).sha;
      } catch(e) {}
      const body = {
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch
      };
      if (sha) body.sha = sha;
      const res = await fetch(`${apiBase}/${path}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`PUT ${path} → ${res.status}: ${await res.text()}`);
      return res.json();
    }

    const csvFiles = await listFiles('reportes');
    const csvs = csvFiles.filter(f => f.name.endsWith('.csv') && f.name !== 'consolidado.csv');
    let jsonFiles = [];
    try { jsonFiles = await listFiles('reportes/json'); } catch(e) {}
    const existing = new Set(jsonFiles.filter(f => f.name.endsWith('.json')).map(f => f.name));

    const results = [];
    for (const csvFile of csvs) {
      const jsonName = csvFile.name.replace(/\.csv$/, '.json');
      if (existing.has(jsonName) && !force) {
        results.push({ file: csvFile.name, status: 'ya existe (usa ?force=1 para regenerar)' });
        continue;
      }
      try {
        const csvText = await getFileContent(`reportes/${csvFile.name}`);
        if (!csvText) { results.push({ file: csvFile.name, status: 'no leído' }); continue; }
        const report = parseDetailedCsv(csvText);
        if (!report.fecha) { results.push({ file: csvFile.name, status: 'sin fecha' }); continue; }
        report.id = uid();
        await putFileContent(`reportes/json/${jsonName}`, JSON.stringify(report, null, 2), `Migrar ${csvFile.name}`);
        results.push({ file: csvFile.name, status: force ? 'regenerado' : 'migrado', fecha: report.fecha });
      } catch (e) {
        results.push({ file: csvFile.name, status: 'error: ' + e.message });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, force, results }, null, 2) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') q = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseDetailedCsv(text) {
  const rows = text.replace(/\r\n/g, '\n').split('\n').map(parseCsvLine);
  const M = ['01','02','03','04','05'];
  const rep = {
    id:'', fecha:'', responsable:'', creado:new Date().toISOString(),
    hilanderia:{ kgsOE:'', kgsCarda:'', titulos:[], inactivos:{ m:['','','','',''], causa:'' }, parados:{}, corregidos:{} },
    novedadesPlanta:[],
    humedos:{ unipacks:[], urdido:[], tenido:[], reurdido:[], engomado:{ metros:'', rows:[], porEngomar:[] }, novedades:[] },
    tejeduria:{ metros:'', rot:'', cargados:'', operativos:'', parados:'', cadenas:'',
      causas:{ mecanica:'', electronica:'', electrica:'', montaje:'', repuesto:'', repuestoTelares:'' },
      otros:{ presion:'', orden:'', urdimbre:'', urdimbreDet:'', calidad:'', ecu:'', trama:'' } },
    acabado:{ sanforizado:'', revision:'', corte:'', calidad:'', inventario:'', novedades:[] }
  };
  const nonEmpty = r => r && r.some(c => c && c.trim());
  const first = r => (r && r[0] ? r[0].trim() : '');
  const isSection = s => s.startsWith('==') && s.endsWith('==');

  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (isSection(first(r))) break;
    if (first(r) === 'Fecha del informe') rep.fecha = (r[1]||'').trim();
    else if (first(r) === 'Responsable') rep.responsable = (r[1]||'').trim();
    else if (first(r) === 'Creado') rep.creado = (r[1]||'').trim();
    i++;
  }

  while (i < rows.length) {
    const r = rows[i];
    if (!nonEmpty(r)) { i++; continue; }
    const c0 = first(r);
    if (!isSection(c0)) { i++; continue; }

    const section = c0.replace(/^==\s*|\s*==$/g, '').trim();
    i++;

    if (section === 'HILANDERIA') {
      while (i < rows.length) {
        const r2 = rows[i];
        if (!nonEmpty(r2)) { i++; continue; }
        const k = first(r2);
        if (isSection(k)) break;

        if (k === 'Concepto') { i++; continue; }
        if (k === 'Kgs producidos en Open-End') { rep.hilanderia.kgsOE = (r2[1]||'').trim(); i++; continue; }
        if (k === 'Kgs producidos en Carda') { rep.hilanderia.kgsCarda = (r2[1]||'').trim(); i++; continue; }

        if (k === 'Titulos Open-End') {
          i++;
          if (first(rows[i]) === 'Open-End') i++;
          while (i < rows.length) {
            const r3 = rows[i];
            if (!nonEmpty(r3) || isSection(first(r3))) break;
            if (first(r3) === 'Puestos Inactivos Open-End') break;
            rep.hilanderia.titulos.push({ maquina:first(r3), titulo:(r3[1]||'').trim(), uso:(r3[2]||'').trim() });
            i++;
          }
          continue;
        }

        if (k === 'Puestos Inactivos Open-End') {
          i++;
          if (first(rows[i]) === 'Open-End') i++;
          while (i < rows.length) {
            const r3 = rows[i];
            if (!nonEmpty(r3) || isSection(first(r3))) break;
            const c = first(r3);
            if (c === 'Puestos Parados por Causa') break;
            if (M.includes(c)) { rep.hilanderia.inactivos.m[M.indexOf(c)] = (r3[1]||'').trim(); }
            else if (c === 'Causa') { rep.hilanderia.inactivos.causa = (r3[1]||'').trim(); }
            i++;
          }
          continue;
        }

        if (k === 'Puestos Parados por Causa' || k === 'Puestos Corregidos por Causa') {
          const isParados = k === 'Puestos Parados por Causa';
          const target = isParados ? rep.hilanderia.parados : rep.hilanderia.corregidos;
          const map = isParados
            ? { 'Inactivos':'inactivos', 'Ajustes':'ajustes', 'F.A.':'fa' }
            : { 'Ajuste-Fuga':'ajustefuga', 'Fuentes':'fuentes', 'Fugas':'fugas', 'Amortig/Fuga':'amortig' };
          i++;
          if (first(rows[i]) === 'Causa') i++;
          while (i < rows.length) {
            const r3 = rows[i];
            if (!nonEmpty(r3) || isSection(first(r3))) break;
            const c = first(r3);
            if (c === 'Total') { i++; continue; }
            const key = map[c] || c.toLowerCase();
            const obj = {};
            M.forEach((m, idx) => { const v = (r3[idx+1]||'').trim(); if (v !== '') obj[m] = v; });
            target[key] = obj;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }

    if (section === 'NOVEDADES DE PLANTA') {
      i++;
      while (i < rows.length) {
        const r2 = rows[i];
        if (!nonEmpty(r2) || isSection(first(r2))) break;
        if (first(r2) === 'N') { i++; continue; }
        const det = (r2[1] || '').trim();
        if (det) rep.novedadesPlanta.push(det);
        i++;
      }
      continue;
    }

    if (section === 'PROCESOS HUMEDOS') {
      while (i < rows.length) {
        const r2 = rows[i];
        if (!nonEmpty(r2)) { i++; continue; }
        const k = first(r2);
        if (isSection(k)) break;

        if (k === 'Inventario de Unipacks en Urdido') {
          i++;
          if (first(rows[i]) === 'Titulo') i++;
          while (i < rows.length) {
            const r3 = rows[i];
            if (!nonEmpty(r3) || isSection(first(r3))) break;
            if (first(r3) === 'Urdido') break;
            rep.humedos.unipacks.push({ titulo:first(r3), unipacks:(r3[1]||'').trim(), openend:(r3[2]||'').trim() });
            i++;
          }
          continue;
        }

        if (k === 'Urdido') {
          i++;
          if (first(rows[i]) === 'Urdidora') i++;
          while (i < rows.length) {
            const r3 = rows[i];
            if (!nonEmpty(r3) || isSection(first(r3))) break;
            if (first(r3) === 'Tenido') break;
            rep.humedos.urdido.push({
              urdidora:first(r3), estilo:(r3[1]||'').trim(), lote:(r3[2]||'').trim(),
              mh:(r3[3]||'').trim(), mph:(r3[4]||'').trim()
            });
            i++;
          }
          continue;
        }

        if (k === 'Tenido') {
          i++;
          if (first(rows[i]) === 'Tren') i++;
          while (i < rows.length) {
            const r3 = rows[i];
            if (!nonEmpty(r3) || isSection(first(r3))) break;
            if (first(r3) === 'Reurdido') break;
            rep.humedos.tenido.push({
              tren:first(r3), estilo:(r3[1]||'').trim(), lote:(r3[2]||'').trim(),
              mh:(r3[3]||'').trim(), mph:(r3[4]||'').trim(), obs:(r3[5]||'').trim()
            });
            i++;
          }
          continue;
        }

        if (k === 'Reurdido') {
          i++;
          if (first(rows[i]) === 'Estilo') i++;
          while (i < rows.length) {
            const r3 = rows[i];
            if (!nonEmpty(r3) || isSection(first(r3))) break;
            if (first(r3) === 'Engomado') break;
            rep.humedos.reurdido.push({
              estilo:first(r3), lote:(r3[1]||'').trim(), mh:(r3[2]||'').trim(), mph:(r3[3]||'').trim()
            });
            i++;
          }
          continue;
        }

        if (k === 'Engomado') {
          i++;
          while (i < rows.length) {
            const r3 = rows[i];
            if (!nonEmpty(r3) || isSection(first(r3))) break;
            const c = first(r3);
            if (c === 'Metros engomados del dia anterior') { rep.humedos.engomado.metros = (r3[1]||'').trim(); i++; continue; }
            if (c === 'Engomadora') { i++; break; }
            break;
          }
          while (i < rows.length) {
            const r3 = rows[i];
            if (!nonEmpty(r3) || isSection(first(r3))) break;
            if (first(r3) === 'Pendientes por Engomar') break;
            rep.humedos.engomado.rows.push({
              engomadora:first(r3), estilo:(r3[1]||'').trim(), lote:(r3[2]||'').trim(),
              mh:(r3[3]||'').trim(), mph:(r3[4]||'').trim(), obs:(r3[5]||'').trim()
            });
            i++;
          }
          continue;
        }

        if (k === 'Pendientes por Engomar') {
          i++;
          if (first(rows[i]) === 'Estilo') i++;
          while (i < rows.length) {
            const r3 = rows[i];
            if (!nonEmpty(r3) || isSection(first(r3))) break;
            if (first(r3) === 'Novedades de Engomado') break;
            rep.humedos.engomado.porEngomar.push({
              estilo:first(r3), lote:(r3[1]||'').trim(), mh:(r3[2]||'').trim(), mph:(r3[3]||'').trim()
            });
            i++;
          }
          continue;
        }

        if (k === 'Novedades de Engomado') {
          i++;
          while (i < rows.length) {
            const r3 = rows[i];
            if (!nonEmpty(r3) || isSection(first(r3))) break;
            const det = (r3[1] || '').trim();
            if (det) rep.humedos.novedades.push(det);
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }

    if (section === 'TEJEDURIA') {
      while (i < rows.length) {
        const r2 = rows[i];
        if (!nonEmpty(r2)) { i++; continue; }
        const k = first(r2);
        if (isSection(k)) break;

        if (k === 'Concepto') { i++; continue; }
        if (k === 'Metros tejidos del dia anterior') { rep.tejeduria.metros = (r2[1]||'').trim(); i++; continue; }
        if (k === 'Promedio Rot/hora') { rep.tejeduria.rot = (r2[1]||'').trim(); i++; continue; }
        if (k === 'Telares cargados') { rep.tejeduria.cargados = (r2[1]||'').trim(); i++; continue; }
        if (k === 'Telares operativos') { rep.tejeduria.operativos = (r2[1]||'').trim(); i++; continue; }
        if (k === 'Telares parados') { rep.tejeduria.parados = (r2[1]||'').trim(); i++; continue; }
        if (k === 'Cadenas inventario') { rep.tejeduria.cadenas = (r2[1]||'').trim(); i++; continue; }

        if (k === 'Causas de telares parados') {
          i++;
          if (first(rows[i]) === 'Causa') i++;
          const map = { 'Mecanica':'mecanica', 'Electronica':'electronica', 'Electrica':'electrica', 'Montaje':'montaje', 'Repuesto':'repuesto' };
          while (i < rows.length) {
            const r3 = rows[i];
            if (!nonEmpty(r3) || isSection(first(r3))) break;
            const c = first(r3);
            if (c === 'Otros paros') break;
            const key = map[c];
            if (key) {
              rep.tejeduria.causas[key] = (r3[1]||'').trim();
              if (c === 'Repuesto') rep.tejeduria.causas.repuestoTelares = (r3[2]||'').trim();
            }
            i++;
          }
          continue;
        }

        if (k === 'Otros paros') {
          i++;
          if (first(rows[i]) === 'Causa') i++;
                    const map = {
            'Presion de aire':'presion', 'Orden superior':'orden', 'Falta de urdimbre':'urdimbre',
            'Calidad':'calidad', 'E.C.U.':'ecu', 'Falta de trama':'trama',
            'Otros':'otros'
          };
          while (i < rows.length) {
            const r3 = rows[i];
            if (!nonEmpty(r3) || isSection(first(r3))) break;
            const c = first(r3);
            const key = map[c];
            if (key) {
              rep.tejeduria.otros[key] = (r3[1]||'').trim();
              if (c === 'Falta de urdimbre') rep.tejeduria.otros.urdimbreDet = (r3[2]||'').trim();
              if (c === 'Otros') rep.tejeduria.otros.otrosDet = (r3[2]||'').trim();
            }
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }

    if (section === 'PLANTA ACABADO') {
      i++;
      while (i < rows.length) {
        const r2 = rows[i];
        // ← FIX: usar continue en vacías, no break
        if (!nonEmpty(r2)) { i++; continue; }
        if (isSection(first(r2))) break;
        const c = first(r2);
        if (c === 'Seccion') { i++; continue; }
        if (c === 'Sanforizado') { rep.acabado.sanforizado = (r2[1]||'').trim(); }
        else if (c === 'Revision') { rep.acabado.revision = (r2[1]||'').trim(); }
        else if (c === 'Corte') { rep.acabado.corte = (r2[1]||'').trim(); }
        else if (c === 'General valor primera calidad (%)') { rep.acabado.calidad = (r2[1]||'').trim(); }
        else if (c === 'Inventario Tela Cruda (Noria)') { rep.acabado.inventario = (r2[1]||'').trim(); }
        else if (c === 'Novedades de Acabado') {
          i++;
          while (i < rows.length) {
            const r3 = rows[i];
            if (!nonEmpty(r3) || isSection(first(r3))) break;
            const det = (r3[1] || '').trim();
            if (det) rep.acabado.novedades.push(det);
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
  }

  return rep;
}
