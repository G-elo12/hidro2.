// ============================================================
//  Servidor Node.js — WebSocket + Express + MongoDB
//  npm install ws express mongoose
//  node server.js
// ============================================================

const express   = require('express');
const http      = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const mongoose  = require('mongoose');

// ── Configuración ──────────────────────────────────────────
const PORT     = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://utau242020_db_user:KG2aWhnt0MiErlPX@cluster0.qjywjn3.mongodb.net/?appName=Cluster0';

// ── Mongoose — Esquemas ────────────────────────────────────

// Registro histórico de sensores (se guarda cada lectura del ESP32)
const sensorSchema = new mongoose.Schema({
  temperatura: { type: Number, default: null },
  ph:          { type: Number, default: null },
  nivel:       { type: Number, default: null },
  bomba:       { type: Boolean, default: false },
  createdAt:   { type: Date,    default: Date.now, index: true }
});

// TTL: borra registros con más de 30 días automáticamente
sensorSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

const SensorLog = mongoose.model('SensorLog', sensorSchema);

// Historial de notificaciones/alertas
const notifSchema = new mongoose.Schema({
  mensaje:   { type: String, required: true },
  createdAt: { type: Date, default: Date.now, index: true }
});
notifSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 }); // 7 días

const Notificacion = mongoose.model('Notificacion', notifSchema);

// ── Conexión MongoDB ───────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => timestamp('[MongoDB] Conectado correctamente.'))
  .catch(err => {
    timestamp(`[MongoDB] ERROR de conexión: ${err.message}`);
    timestamp('[MongoDB] El servidor seguirá funcionando con estado en memoria.');
  });

// ── App Express ────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
app.use(express.json());

// ── Estado en memoria (fallback si MongoDB no responde) ────
let estadoBomba   = false;
let datosSensores = { temperatura: null, ph: null, nivel: null };

// ══════════════════════════════════════════════════════════
//  ENDPOINTS REST
// ══════════════════════════════════════════════════════════

// POST /cmd  { "bomba": true | false }
app.post('/cmd', (req, res) => {
  const { bomba } = req.body;

  if (typeof bomba !== 'boolean') {
    return res.status(400).json({ error: 'Falta el campo "bomba" (true o false)' });
  }

  estadoBomba = bomba;

  const payload = JSON.stringify({ type: 'cmd', bomba: estadoBomba });
  broadcast(payload, 'esp32');
  broadcast(payload, 'dashboard');
  timestamp(`[REST→WS] Bomba ${estadoBomba ? 'ENCENDIDA' : 'APAGADA'}`);

  res.json({ ok: true, bomba: estadoBomba });
});

// GET /state  — estado actual (bomba + última lectura de sensores)
app.get('/state', (_req, res) => {
  res.json({ bomba: estadoBomba, sensores: datosSensores });
});

// GET /status  — clientes WebSocket conectados
app.get('/status', (_req, res) => {
  const clientes = [...clienteMap.values()].map(({ device, ip }) => ({ device, ip }));
  res.json({ clientes, total: clienteMap.size });
});

// ── Historial de notificaciones ────────────────────────────
// GET /notifications?limit=50
app.get('/notifications', async (_req, res) => {
  try {
    const limit = parseInt(_req.query.limit) || 50;
    const docs = await Notificacion.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ notificaciones: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Endpoints para gráficas ────────────────────────────────

// GET /history
//   ?range=1h | 6h | 24h | 7d | 30d   (default: 1h)
//   ?field=temperatura | ph | nivel    (default: todos)
//   ?limit=500                         (máximo de puntos)
//
// Devuelve array de puntos listos para graficar:
//   [ { t: "ISO8601", temperatura, ph, nivel, bomba }, ... ]
app.get('/history', async (req, res) => {
  try {
    const { range = '1h', field, limit = 500 } = req.query;

    // Calcular ventana de tiempo
    const ahora = new Date();
    const ventanas = {
      '1h':  1  * 60 * 60 * 1000,
      '6h':  6  * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d':  7  * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };
    const ms = ventanas[range] || ventanas['1h'];
    const desde = new Date(ahora.getTime() - ms);

    // Proyección: sólo los campos pedidos
    const proyecto = { createdAt: 1, bomba: 1 };
    if (!field || field === 'temperatura') proyecto.temperatura = 1;
    if (!field || field === 'ph')          proyecto.ph = 1;
    if (!field || field === 'nivel')       proyecto.nivel = 1;

    // Submuestreo: si hay muchos puntos, tomamos 1 de cada N
    const totalDocs = await SensorLog.countDocuments({ createdAt: { $gte: desde } });
    const lim = Math.min(parseInt(limit), 1000);
    const skip = totalDocs > lim ? Math.floor(totalDocs / lim) : 1;

    // Usamos aggregate para submuestreo eficiente con $bucket o simple skip
    const datos = await SensorLog.find({ createdAt: { $gte: desde } })
      .select(proyecto)
      .sort({ createdAt: 1 })
      .lean();

    // Submuestreo en memoria (evita puntos excesivos)
    const muestreado = skip > 1
      ? datos.filter((_, i) => i % skip === 0)
      : datos;

    // Formatear para Chart.js / Recharts / cualquier lib
    const puntos = muestreado.map(d => ({
      t:            d.createdAt.toISOString(),
      temperatura:  d.temperatura,
      ph:           d.ph,
      nivel:        d.nivel,
      bomba:        d.bomba,
    }));

    res.json({
      range,
      total:  totalDocs,
      puntos: puntos.length,
      data:   puntos,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /stats
//   ?range=1h | 6h | 24h | 7d | 30d
//
// Devuelve estadísticas agregadas (min, max, avg, last) de cada campo.
// Útil para tarjetas de resumen en el dashboard.
app.get('/stats', async (req, res) => {
  try {
    const { range = '24h' } = req.query;
    const ventanas = {
      '1h':  1  * 60 * 60 * 1000,
      '6h':  6  * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d':  7  * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };
    const ms    = ventanas[range] || ventanas['24h'];
    const desde = new Date(Date.now() - ms);

    const [agg] = await SensorLog.aggregate([
      { $match: { createdAt: { $gte: desde } } },
      {
        $group: {
          _id: null,
          tempMin:  { $min: '$temperatura' },
          tempMax:  { $max: '$temperatura' },
          tempAvg:  { $avg: '$temperatura' },
          tempLast: { $last: '$temperatura' },
          phMin:    { $min: '$ph' },
          phMax:    { $max: '$ph' },
          phAvg:    { $avg: '$ph' },
          phLast:   { $last: '$ph' },
          nivelMin: { $min: '$nivel' },
          nivelMax: { $max: '$nivel' },
          nivelAvg: { $avg: '$nivel' },
          nivelLast:{ $last: '$nivel' },
          total:    { $sum: 1 },
        }
      }
    ]);

    if (!agg) return res.json({ range, total: 0, stats: null });

    const round = v => v != null ? Math.round(v * 100) / 100 : null;

    res.json({
      range,
      total: agg.total,
      stats: {
        temperatura: { min: round(agg.tempMin),  max: round(agg.tempMax),  avg: round(agg.tempAvg),  last: round(agg.tempLast) },
        ph:          { min: round(agg.phMin),    max: round(agg.phMax),    avg: round(agg.phAvg),    last: round(agg.phLast) },
        nivel:       { min: round(agg.nivelMin), max: round(agg.nivelMax), avg: round(agg.nivelAvg), last: round(agg.nivelLast) },
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  WEBSOCKET
// ══════════════════════════════════════════════════════════
const wss       = new WebSocketServer({ server });
const clienteMap = new Map();

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  clienteMap.set(ws, { device: 'unknown', ip });
  timestamp(`Cliente conectado desde ${ip}. Total: ${wss.clients.size}`);

  ws.on('message', async (rawData) => {
    let data;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      console.error('[JSON] Trama inválida:', rawData.toString());
      return;
    }

    switch (data.type) {

      case 'register': {
        const device = data.device || 'unknown';
        clienteMap.set(ws, { device, ip });
        timestamp(`Registrado: ${device} (${ip})`);
        enviar(ws, { type: 'ack', msg: `Bienvenido, ${device}` });

        // Sincronizar estado actual al nuevo dashboard
        if (device === 'dashboard') {
          enviar(ws, { type: 'state_sync', bomba: estadoBomba, sensores: datosSensores });
          timestamp(`[SYNC] Estado enviado a ${ip}`);
        }
        break;
      }

      case 'sensor_data': {
        const { temperatura, ph, nivel } = data;

        // Actualizar estado en memoria
        datosSensores = { temperatura, ph, nivel };

        // Persistir en MongoDB
        guardarLectura(temperatura, ph, nivel).catch(console.error);

        // Evaluar alertas
        evaluarNotificaciones(temperatura, ph, nivel).catch(console.error);

        timestamp(`[ESP32] Temp=${temperatura}°C | pH=${ph} | Nivel=${nivel}%`);
        broadcast(JSON.stringify({ type: 'sensor_data', sensores: datosSensores }), 'dashboard');
        break;
      }

      case 'ping':
        enviar(ws, { type: 'pong' });
        break;

      default:
        console.log(`[WS] Tipo desconocido: ${data.type}`);
    }
  });

  ws.on('close', (code) => {
    const info = clienteMap.get(ws) || {};
    timestamp(`Desconectado: ${info.device || 'unknown'} (${info.ip}) — código ${code}`);
    clienteMap.delete(ws);
  });

  ws.on('error', err => console.error('[WS] Error:', err.message));
});

// ══════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════

async function guardarLectura(temperatura, ph, nivel) {
  if (mongoose.connection.readyState !== 1) return; // no conectado
  await SensorLog.create({ temperatura, ph, nivel, bomba: estadoBomba });
}

async function evaluarNotificaciones(temperatura, ph, nivel) {
  let alerta = null;

  if (temperatura != null && temperatura > 30)
    alerta = `Temperatura alta: ${temperatura}°C`;
  else if (ph != null && (ph < 6.0 || ph > 8.0))
    alerta = `pH fuera de rango: ${ph}`;
  else if (nivel != null && nivel < 20)
    alerta = `Nivel de agua bajo: ${nivel}%`;

  if (!alerta) return;

  const notif = { mensaje: alerta };
  timestamp(`[ALERTA] ${alerta}`);

  // Persistir
  if (mongoose.connection.readyState === 1) {
    await Notificacion.create(notif);
  }

  // Broadcast en tiempo real
  broadcast(JSON.stringify({ type: 'notification', data: { ...notif, fecha: new Date().toISOString() } }), 'dashboard');
}

function enviar(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(payload, targetDevice = '*') {
  for (const [ws, info] of clienteMap.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (targetDevice !== '*' && info.device !== targetDevice) continue;
    ws.send(payload);
  }
}

function timestamp(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Arrancar ───────────────────────────────────────────────
server.listen(PORT, () => {
  timestamp(`Servidor en http://localhost:${PORT}`);
  console.log('──────────────────────────────────────────────');
  console.log('  POST /cmd                {"bomba": true/false}');
  console.log('  GET  /state              Estado actual');
  console.log('  GET  /status             Clientes WS');
  console.log('  GET  /history?range=24h  Datos históricos');
  console.log('  GET  /stats?range=24h    Min/max/avg por campo');
  console.log('  GET  /notifications      Historial de alertas');
  console.log('──────────────────────────────────────────────');
});