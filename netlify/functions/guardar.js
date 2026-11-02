
// netlify/functions/guardar.js
exports.handler = async (event) => {
  // Solo aceptar POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { filename, csvContent } = JSON.parse(event.body);
    const token = process.env.GITHUB_TOKEN;
    
    // ⚠️ CAMBIA ESTOS VALORES POR LOS TUYOS
    const owner = 'fherross3-ops';
    const repo = 'JTX-Reporte';
    const path = `reportes/${filename}`; // Carpeta donde se guardarán los CSV

    if (!token) {
      return { statusCode: 500, body: 'Token no configurado' };
    }

    // 1. Verificar si el archivo ya existe (para obtener el SHA si hay que actualizarlo)
    const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const getRes = await fetch(getUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });

    let sha = null;
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    } else if (getRes.status !== 404) {
      // Si no es 404, hay un error real (permisos, repo no encontrado, etc.)
      throw new Error(`GitHub GET error: ${getRes.status}`);
    }

    // 2. Codificar el CSV en Base64 (la API de GitHub lo requiere así)
    const contentBase64 = Buffer.from(csvContent, 'utf8').toString('base64');

    // 3. Crear o actualizar el archivo
    const putBody = {
      message: `Reporte ${filename}`,
      content: contentBase64,
      branch: 'main', // o la rama que uses
    };
    if (sha) putBody.sha = sha;

    const putRes = await fetch(getUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(putBody),
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      throw new Error(`GitHub PUT error: ${putRes.status} - ${errText}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, path }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
