// netlify/functions/guardar.js
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { filename, csvContent, summaryRow } = JSON.parse(event.body);
    const token = process.env.GITHUB_TOKEN;

    const owner = 'fherross3-ops';
    const repo = 'JTX-Reporte';
    const branch = 'main';

    if (!token) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Token no configurado' }) };
    }

    const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents`;

    async function getFile(path) {
      const res = await fetch(`${apiBase}/${path}?ref=${branch}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
      const data = await res.json();
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      return { sha: data.sha, content };
    }

    async function putFile(path, content, message, sha = null) {
      const body = {
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch,
      };
      if (sha) body.sha = sha;
      const res = await fetch(`${apiBase}/${path}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`PUT ${path} → ${res.status}: ${errText}`);
      }
      return res.json();
    }

    // ---- 1. Guardar el CSV individual (detalle) ----
    const detailPath = `reportes/${filename}`;
    const existingDetail = await getFile(detailPath);
    await putFile(
      detailPath,
      csvContent,
      `Reporte detalle ${filename}`,
      existingDetail ? existingDetail.sha : null
    );

    // ---- 2. Actualizar el consolidado (una fila por fecha) ----
    const consolidatedPath = 'reportes/consolidado.csv';
    const CONSOLIDATED_HEADER = [
      'Fecha','Responsable','Kgs_OE','Kgs_Carda','Puestos_Inactivos','Pct_Inactivos',
      'Metros_Tejidos','Rot_Hora','Telares_Cargados','Telares_Operativos','Telares_Parados',
      'Cadenas','Metros_Engomados','Sanforizado','Revision','Corte','Primera_Calidad',
      'Inventario_Tela_Cruda','Novedades_Planta'
    ];

    const existingConsolidated = await getFile(consolidatedPath);
    let lines = [];
    if (existingConsolidated && existingConsolidated.content.trim()) {
      lines = existingConsolidated.content
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter(l => l.trim() !== '');
    }

    if (lines.length === 0) {
      lines.push(CONSOLIDATED_HEADER.join(','));
    }

    const fecha = String(summaryRow[0] ?? '').trim();

    let replaced = false;
    for (let i = 1; i < lines.length; i++) {
      const firstCol = lines[i].split(',')[0].replace(/^"|"$/g, '').trim();
      if (firstCol === fecha) {
        lines[i] = summaryRow.map(csvEscape).join(',');
        replaced = true;
        break;
      }
    }

    if (!replaced) {
      lines.push(summaryRow.map(csvEscape).join(','));
    }

    const consolidatedContent = lines.join('\r\n');

    await putFile(
      consolidatedPath,
      consolidatedContent,
      `Consolidado actualizado (${fecha})`,
      existingConsolidated ? existingConsolidated.sha : null
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        detail: detailPath,
        consolidated: consolidatedPath,
        replaced,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
