import express from 'express';
import mysql from 'mysql2/promise';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------
// Conexión a RDS (pool de conexiones reutilizables).
// Los valores vienen de variables de entorno del contenedor.
// ---------------------------------------------------------------
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 5,
});

// Peso de cada tipo de evento en el "score" de tendencia:
// un "me gusta" vale más que una simple reproducción.
const WEIGHT_PLAY = 1;
const WEIGHT_LIKE = 3;

// ---------------------------------------------------------------
// El API Gateway ya validó el JWT de Cognito antes de reenviar la
// petición hasta aquí. Solo leemos el "sub" (ID del usuario) del payload.
// ---------------------------------------------------------------
function getUserSub(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
    );
    return payload.sub || null;
  } catch {
    return null;
  }
}

// Health check (útil para OpenShift y para probar rápido que el pod vive)
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---------------------------------------------------------------
// POST /plays  { trackId, trackTitle }
// Registra una reproducción del usuario autenticado.
// ---------------------------------------------------------------
app.post('/plays', async (req, res) => {
  const userSub = getUserSub(req);
  if (!userSub) return res.status(401).json({ message: 'No autenticado' });

  const { trackId, trackTitle } = req.body || {};
  if (!trackId || !trackTitle) {
    return res.status(400).json({ message: 'trackId y trackTitle son requeridos' });
  }

  try {
    await pool.execute(
      `INSERT INTO track_events (user_sub, track_id, track_title, event_type)
       VALUES (?, ?, ?, 'play')`,
      [userSub, trackId, trackTitle]
    );
    res.status(201).json({ message: 'Reproducción registrada' });
  } catch (err) {
    console.error('Error registrando reproducción:', err);
    res.status(500).json({ message: 'Error interno', error: err.message });
  }
});

// ---------------------------------------------------------------
// GET /trending?limit=10&days=7
// Calcula el ranking de canciones en tendencia: agrega reproducciones
// y "me gusta" de los últimos N días y los pondera en un score.
// ---------------------------------------------------------------
app.get('/trending', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 365);

  try {
    const [rows] = await pool.query(
      `SELECT
         track_id,
         MAX(track_title) AS track_title,
         SUM(event_type = 'play') AS plays,
         SUM(event_type = 'like') AS likes,
         (SUM(event_type = 'play') * ? + SUM(event_type = 'like') * ?) AS score
       FROM track_events
       WHERE created_at >= NOW() - INTERVAL ? DAY
       GROUP BY track_id
       ORDER BY score DESC, plays DESC
       LIMIT ?`,
      [WEIGHT_PLAY, WEIGHT_LIKE, days, limit]
    );

    // MySQL devuelve los SUM como texto; los pasamos a número.
    const trending = rows.map((r, i) => ({
      rank: i + 1,
      trackId: r.track_id,
      title: r.track_title,
      plays: Number(r.plays),
      likes: Number(r.likes),
      score: Number(r.score),
    }));

    res.json(trending);
  } catch (err) {
    console.error('Error calculando tendencias:', err);
    res.status(500).json({ message: 'Error interno', error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Motor de tendencias escuchando en el puerto ${PORT}`);
});
