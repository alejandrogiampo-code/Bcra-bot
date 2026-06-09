const TelegramBot = require("node-telegram-bot-api");
const AdmZip = require("adm-zip");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error("Falta BOT_TOKEN"); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });

// ── Lista blanca ──────────────────────────────────────────────────────────────
const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? new Set(process.env.ALLOWED_USERS.split(",").map(id => id.trim()))
  : null;

function usuarioAutorizado(msg) {
  if (!ALLOWED_USERS) return true;
  return ALLOWED_USERS.has(String(msg.from?.id));
}
function rechazarAcceso(chatId) {
  bot.sendMessage(chatId, "🔒 No tenes acceso a este bot.\nContacta al administrador.");
}

// ── Base de datos en memoria ──────────────────────────────────────────────────
// Estructura: { "20411143156": [ { nroCheque, fechaRechazo, monto, causal, banco, cuenta, pagado } ] }
let baseCheques = {};
let ultimaActualizacion = null;
let estadoBase = "iniciando"; // iniciando | actualizando | lista | error

const SITS = {
  1: { emoji: "🟢", label: "Normal" },
  2: { emoji: "🟡", label: "Riesgo bajo" },
  3: { emoji: "🟠", label: "Riesgo medio" },
  4: { emoji: "🔴", label: "Riesgo alto" },
  5: { emoji: "⛔", label: "Irrecuperable" },
  6: { emoji: "🔵", label: "Irrecup. Tecnica" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseCuit(v) { return v.replace(/\D/g, ""); }
function formatCuit(c) {
  if (c.length !== 11) return c;
  return c.slice(0,2) + "-" + c.slice(2,10) + "-" + c.slice(10);
}
function formatMonto(m) {
  return "$" + Number(m).toLocaleString("es-AR", { minimumFractionDigits: 2 });
}

async function fetchBCRA(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

// ── Descarga y procesamiento de ZIPs del BCRA ────────────────────────────────
// Formato del archivo TXT dentro del ZIP (según documentación BCRA "A 8340"):
// Posiciones fijas:
// 1      : Tipo de registro (A=alta, B=baja, M=modificacion)
// 2-4    : Codigo de entidad (banco)
// 5-9    : Nro de sucursal
// 10-19  : Nro de cuenta corriente
// 20-27  : Nro de cheque
// 28-33  : Año y numero de aviso (AAANNN)
// 34     : Codigo de movimiento
// 35     : Clase de registro (R=rechazado, D=denunciado)
// 36     : Fecha de notificacion (AAAAMMDD)
// 37-38  : Causal (01=sin fondos, 02=defectos formales, 03=denunciado)
// 39-40  : Codigo de moneda
// 41-55  : Importe (15 digitos, 2 decimales implicitos)
// 56-63  : Fecha de rechazo (AAAAMMDD)
// 64     : Tipo de cheque (C=comun, D=diferido, E=echeq)
// 65-75  : CUIT del librador
// 76-85  : (otros campos)

const CAUSALES = { "01": "SIN FONDOS", "02": "DEFECTOS FORMALES", "03": "DENUNCIADO" };

function parsearFecha(f) {
  if (!f || f.length < 8) return null;
  return f.slice(6,8) + "/" + f.slice(4,6) + "/" + f.slice(0,4);
}

function parsearLinea(linea) {
  if (linea.length < 75) return null;
  const tipo = linea[0]; // A, B, M
  const clase = linea[34]; // R o D
  const causalCod = linea.slice(36,38).trim();
  const importeStr = linea.slice(40,55).trim();
  const fechaRechazo = linea.slice(55,63).trim();
  const cuit = linea.slice(64,75).trim();
  const nroCheque = linea.slice(19,27).trim();
  const codEntidad = linea.slice(1,4).trim();
  const cuenta = linea.slice(9,19).trim();

  if (!cuit || cuit.length !== 11) return null;

  const monto = importeStr ? parseFloat(importeStr) / 100 : 0;
  const causal = CAUSALES[causalCod] || "SIN FONDOS";
  const fecha = parsearFecha(fechaRechazo);

  return { tipo, cuit, nroCheque: nroCheque.replace(/^0+/, ""), causal, monto, fecha, codEntidad, cuenta, clase };
}

async function descargarYProcesarZip(fecha) {
  // fecha formato YYYYMMDD
  const url = `https://www.bcra.gob.ar/archivos/zips/cheques/${fecha}.zip`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    clearTimeout(timer);
    if (!res.ok) return 0;

    const buffer = await res.arrayBuffer();
    const zip = new AdmZip(Buffer.from(buffer));
    const entries = zip.getEntries();
    let procesados = 0;

    entries.forEach(entry => {
      if (entry.isDirectory) return;
      const contenido = entry.getData().toString("latin1");
      const lineas = contenido.split("\n");

      lineas.forEach(linea => {
        linea = linea.trimEnd();
        if (!linea) return;
        const reg = parsearLinea(linea);
        if (!reg) return;

        const { tipo, cuit, ...datos } = reg;

        if (!baseCheques[cuit]) baseCheques[cuit] = [];

        if (tipo === "A") {
          // Alta: agregar si no existe
          const existe = baseCheques[cuit].find(c => c.nroCheque === datos.nroCheque && c.codEntidad === datos.codEntidad);
          if (!existe) {
            baseCheques[cuit].push({ ...datos, pagado: false });
            procesados++;
          }
        } else if (tipo === "B") {
          // Baja: marcar como pagado
          const idx = baseCheques[cuit]?.findIndex(c => c.nroCheque === datos.nroCheque && c.codEntidad === datos.codEntidad);
          if (idx !== -1) baseCheques[cuit][idx].pagado = true;
        } else if (tipo === "M") {
          // Modificacion: actualizar
          const idx = baseCheques[cuit]?.findIndex(c => c.nroCheque === datos.nroCheque && c.codEntidad === datos.codEntidad);
          if (idx !== -1) Object.assign(baseCheques[cuit][idx], datos);
        }
      });
    });

    return procesados;
  } catch (e) {
    clearTimeout(timer);
    console.error("Error descargando ZIP", fecha, e.message);
    return 0;
  }
}

function fechasUltimos90Dias() {
  const fechas = [];
  const hoy = new Date();
  for (let i = 0; i < 90; i++) {
    const d = new Date(hoy);
    d.setDate(hoy.getDate() - i);
    const dia = d.getDate().toString().padStart(2, "0");
    const mes = (d.getMonth() + 1).toString().padStart(2, "0");
    const anio = d.getFullYear();
    fechas.push(`${anio}${mes}${dia}`);
  }
  return fechas;
}

function fechaHoy() {
  const hoy = new Date();
  const dia = hoy.getDate().toString().padStart(2, "0");
  const mes = (hoy.getMonth() + 1).toString().padStart(2, "0");
  const anio = hoy.getFullYear();
  return `${anio}${mes}${dia}`;
}

// Carga inicial: últimos 90 días
async function cargaInicial() {
  console.log("Iniciando carga de base de cheques (ultimos 90 dias)...");
  estadoBase = "actualizando";
  const fechas = fechasUltimos90Dias();
  let total = 0;
  let archivos = 0;

  for (const fecha of fechas) {
    const n = await descargarYProcesarZip(fecha);
    if (n > 0) { total += n; archivos++; }
  }

  ultimaActualizacion = new Date().toLocaleString("es-AR");
  estadoBase = "lista";
  console.log(`Base lista: ${archivos} archivos, ${total} altas procesadas, ${Object.keys(baseCheques).length} CUITs con cheques.`);
}

// Actualización diaria: solo el ZIP del día
async function actualizarDiario() {
  console.log("Actualizacion diaria...");
  const fecha = fechaHoy();
  const n = await descargarYProcesarZip(fecha);
  ultimaActualizacion = new Date().toLocaleString("es-AR");
  console.log(`Actualizacion diaria: ${n} registros del ${fecha}`);
}

// ── Consulta BCRA API (deudas) ────────────────────────────────────────────────
async function consultarDeudas(cuit) {
  return fetchBCRA("https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/" + cuit);
}

// ── Armar respuesta ───────────────────────────────────────────────────────────
function armarRespuesta(cuit, deudores, chequesLocales) {
  const fmt = formatCuit(cuit);
  const nombre = deudores?.results?.denominacion || "";
  const periodos = deudores?.results?.periodos || [];

  let lines = [];
  lines.push("🏦 CUIT: " + fmt);
  if (nombre) lines.push("👤 " + nombre);
  lines.push("");

  // Situacion crediticia
  if (periodos.length === 0) {
    lines.push("✅ Sin deudas en el sistema financiero.");
  } else {
    let maxSit = 0;
    periodos.forEach(p =>
      (p.entidades || []).forEach(e => {
        const s = parseInt(e.situacion);
        if (s > maxSit) maxSit = s;
      })
    );
    const sitMax = SITS[maxSit] || { emoji: "❓", label: "S" + maxSit };
    lines.push("📊 Situacion maxima: S" + maxSit + " " + sitMax.emoji + " " + sitMax.label);
    lines.push("");
    periodos.forEach(p => {
      lines.push("📅 Periodo: " + p.periodo);
      (p.entidades || []).forEach(e => {
        const s = parseInt(e.situacion);
        const sit = SITS[s] || { emoji: "❓", label: "S" + s };
        let linea = "  " + sit.emoji + " S" + s + " " + sit.label + " - " + (e.entidad || "Entidad");
        if (e.monto) linea += "  " + formatMonto(e.monto * 1000);
        lines.push(linea);
      });
      lines.push("");
    });
  }

  lines.push("─────────────────────");

  // Cheques rechazados desde base local
  const cheques = (chequesLocales || []).filter(c => !c.pagado);
  const pagados = (chequesLocales || []).filter(c => c.pagado);

  if (cheques.length > 0) {
    lines.push("🚨 Cheques rechazados SIN PAGAR: " + cheques.length);
    // Ordenar por fecha más reciente
    cheques.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
    cheques.slice(0, 15).forEach(ch => {
      lines.push("");
      lines.push("  Cheque N " + (ch.nroCheque || "-"));
      lines.push("  Causal: " + ch.causal);
      if (ch.fecha) lines.push("  Fecha rechazo: " + ch.fecha);
      if (ch.monto) lines.push("  Monto: " + formatMonto(ch.monto));
    });
    if (cheques.length > 15) lines.push("\n  ... y " + (cheques.length - 15) + " mas");
    if (pagados.length > 0) lines.push("\n✅ " + pagados.length + " cheque(s) ya pagado(s).");
  } else if (pagados.length > 0) {
    lines.push("✅ Tenia " + pagados.length + " cheque(s) rechazado(s), todos ya pagados.");
  } else {
    lines.push("✅ Sin cheques rechazados en los ultimos 90 dias.");
  }

  if (ultimaActualizacion) {
    lines.push("");
    lines.push("📅 Base actualizada: " + ultimaActualizacion);
  }

  return lines.join("\n");
}

// ── Procesar CUITs ────────────────────────────────────────────────────────────
async function procesarCUITs(chatId, texto) {
  if (estadoBase === "actualizando" || estadoBase === "iniciando") {
    return bot.sendMessage(chatId,
      "⏳ La base de cheques se esta cargando por primera vez.\n" +
      "Este proceso tarda unos minutos. Por favor intenta en 2-3 minutos."
    );
  }

  const cuits = texto.split(/[\s,;|]+/).map(parseCuit).filter(c => c.length === 11);
  if (cuits.length === 0) {
    if (/\d/.test(texto)) return bot.sendMessage(chatId, "⚠️ CUIT invalido. Debe tener 11 digitos.\nEjemplo: 20123456789");
    return;
  }

  const unique = [...new Set(cuits)];
  if (unique.length > 10) return bot.sendMessage(chatId, "⚠️ Maximo 10 CUITs por consulta.");

  const espera = await bot.sendMessage(chatId,
    unique.length === 1
      ? "🔍 Consultando CUIT " + formatCuit(unique[0]) + "..."
      : "🔍 Consultando " + unique.length + " CUITs..."
  );

  const respuestas = await Promise.all(
    unique.map(async (cuit) => {
      try {
        const deudores = await consultarDeudas(cuit);
        const chequesLocales = baseCheques[cuit] || [];
        return { cuit, deudores, chequesLocales, error: null };
      } catch(e) {
        return { cuit, error: "No se pudo consultar. Intenta de nuevo." };
      }
    })
  );

  try { await bot.deleteMessage(chatId, espera.message_id); } catch {}

  for (const r of respuestas) {
    try {
      if (r.error) {
        await bot.sendMessage(chatId, "❌ CUIT " + formatCuit(r.cuit) + "\n" + r.error);
      } else {
        await bot.sendMessage(chatId, armarRespuesta(r.cuit, r.deudores, r.chequesLocales));
      }
    } catch(e) {
      console.error("Error enviando:", e.message);
      await bot.sendMessage(chatId, "❌ Error mostrando resultado de " + formatCuit(r.cuit));
    }
    if (respuestas.length > 1) await new Promise(r => setTimeout(r, 400));
  }
}

// ── Comandos ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  if (!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  const nombre = msg.from.first_name || "amigo";
  bot.sendMessage(msg.chat.id,
    "👋 Hola " + nombre + "!\n\n" +
    "Soy el bot de consulta del BCRA.\n" +
    "Tengo una base propia de cheques rechazados actualizada diariamente.\n\n" +
    "Manda un CUIT para consultarlo:\n" +
    "20123456789\n" +
    "20-12345678-9\n\n" +
    "O varios juntos:\n" +
    "20123456789, 27987654321\n\n" +
    "/estado - Ver estado de la base\n" +
    "/ayuda - Mas informacion"
  );
});

bot.onText(/\/estado/, (msg) => {
  if (!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  const cuits = Object.keys(baseCheques).length;
  const totalCheques = Object.values(baseCheques).reduce((a, v) => a + v.length, 0);
  bot.sendMessage(msg.chat.id,
    "📊 Estado de la base de cheques:\n\n" +
    "Estado: " + estadoBase + "\n" +
    "CUITs con cheques: " + cuits.toLocaleString("es-AR") + "\n" +
    "Total registros: " + totalCheques.toLocaleString("es-AR") + "\n" +
    "Ultima actualizacion: " + (ultimaActualizacion || "pendiente") + "\n" +
    "Periodo: ultimos 90 dias"
  );
});

bot.onText(/\/ayuda/, (msg) => {
  if (!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "📖 Situaciones crediticias:\n\n" +
    "🟢 S1 - Normal\n" +
    "🟡 S2 - Riesgo bajo (31-90 dias)\n" +
    "🟠 S3 - Riesgo medio (91-180 dias)\n" +
    "🔴 S4 - Riesgo alto (181-365 dias)\n" +
    "⛔ S5 - Irrecuperable\n" +
    "🔵 S6 - Irrecuperable tecnica\n\n" +
    "Los cheques vienen de los archivos diarios del BCRA.\n" +
    "Se actualizan automaticamente todos los dias a las 8 AM.\n\n" +
    "Comandos:\n" +
    "/start - Inicio\n" +
    "/estado - Estado de la base\n" +
    "/ayuda - Esta ayuda"
  );
});

bot.onText(/\/consultar (.+)/, async (msg, match) => {
  if (!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  await procesarCUITs(msg.chat.id, match[1]);
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  if (!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  await procesarCUITs(msg.chat.id, msg.text);
});

bot.on("polling_error", (err) => console.error("Polling error:", err.message));

// ── Cron: actualizar todos los dias a las 8 AM hora Argentina ─────────────────
cron.schedule("0 8 * * *", () => {
  actualizarDiario();
}, { timezone: "America/Argentina/Buenos_Aires" });

// ── Arrancar ──────────────────────────────────────────────────────────────────
console.log("Bot BCRA v2 iniciando...");
cargaInicial();
