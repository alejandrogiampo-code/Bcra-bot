const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ Falta la variable BOT_TOKEN");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// ── Situaciones crediticias ──────────────────────────────────────────────────
const SITS = {
  1: { emoji: "🟢", label: "Normal",           desc: "Cumplimiento normal" },
  2: { emoji: "🟡", label: "Riesgo bajo",       desc: "Atraso 31–90 días" },
  3: { emoji: "🟠", label: "Riesgo medio",      desc: "Atraso 91–180 días" },
  4: { emoji: "🔴", label: "Riesgo alto",       desc: "Atraso 181–365 días" },
  5: { emoji: "⛔", label: "Irrecuperable",     desc: "Más de 365 días / quiebra" },
  6: { emoji: "🔵", label: "Irrecup. Técnica",  desc: "Irrecuperable técnica" },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function parseCuit(texto) {
  return texto.replace(/\D/g, "");
}

function formatCuit(c) {
  if (c.length !== 11) return c;
  return `${c.slice(0,2)}-${c.slice(2,10)}-${c.slice(10)}`;
}

function formatMonto(m) {
  return "$" + Number(m).toLocaleString("es-AR", { minimumFractionDigits: 2 });
}

async function fetchBCRA(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function consultarCUIT(cuit) {
  const [deudores, cheques] = await Promise.all([
    fetchBCRA(`https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/${cuit}`),
    fetchBCRA(`https://api.bcra.gob.ar/cheques/v1.0/deudores/${cuit}`),
  ]);
  return { deudores, cheques };
}

function armarRespuesta(cuit, deudores, cheques) {
  const fmt = formatCuit(cuit);
  const nombre = deudores?.results?.denominacion || "";
  const periodos = deudores?.results?.periodos || [];
  const chequesArr = cheques?.results || [];

  let msg = "";

  // Encabezado
  msg += `🏦 *CUIT: ${fmt}*\n`;
  if (nombre) msg += `👤 ${nombre}\n`;
  msg += `\n`;

  // ── Situación crediticia ──
  if (periodos.length === 0) {
    msg += `✅ *Sin deudas* en el sistema financiero\\.\n`;
  } else {
    // Situación máxima global
    let maxSit = 0;
    periodos.forEach(p =>
      (p.entidades || []).forEach(e => {
        const s = parseInt(e.situacion);
        if (s > maxSit) maxSit = s;
      })
    );
    const sitMax = SITS[maxSit];
    msg += `📊 *Situación máxima: S${maxSit} ${sitMax.emoji} ${escapeMd(sitMax.label)}*\n\n`;

    // Detalle por período
    periodos.forEach(p => {
      msg += `📅 *Período ${p.periodo}*\n`;
      (p.entidades || []).forEach(e => {
        const s = parseInt(e.situacion);
        const sit = SITS[s] || { emoji: "❓", label: `S${s}` };
        const monto = e.monto ? `  💰 ${escapeMd(formatMonto(e.monto))}` : "";
        msg += `  ${sit.emoji} S${s} ${escapeMd(sit.label)} — ${escapeMd(e.entidad || "Entidad")}${monto}\n`;
      });
      msg += "\n";
    });
  }

  // ── Cheques rechazados ──
  if (chequesArr.length > 0) {
    msg += `🏦 *Cheques rechazados: ${chequesArr.length}*\n`;
    chequesArr.slice(0, 10).forEach((ch, i) => {
      const nro = ch.nroCheque || ch.numeroCheque || "—";
      const fecha = ch.fechaRechazo || ch.fecha || "";
      const monto = ch.monto ? formatMonto(ch.monto) : "";
      const motivo = ch.motivoRechazo || "";
      const entidad = ch.entidad || "";
      msg += `\n  📄 *Cheque N° ${escapeMd(String(nro))}*\n`;
      if (fecha) msg += `     📅 Fecha: ${escapeMd(fecha)}\n`;
      if (entidad) msg += `     🏛 ${escapeMd(entidad)}\n`;
      if (monto) msg += `     💰 ${escapeMd(monto)}\n`;
      if (motivo) msg += `     ❗ ${escapeMd(motivo)}\n`;
    });
    if (chequesArr.length > 10) {
      msg += `\n  _\\.\\.\\. y ${chequesArr.length - 10} más_\n`;
    }
  } else {
    msg += `✅ Sin cheques rechazados\\.\n`;
  }

  return msg;
}

// Escapar caracteres especiales para MarkdownV2
function escapeMd(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

// ── Comandos ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const nombre = msg.from.first_name || "amigo";
  bot.sendMessage(msg.chat.id,
    `👋 *Hola ${escapeMd(nombre)}\\!*\n\n` +
    `Soy el bot de consulta del *Central de Deudores del BCRA*\\.\n\n` +
    `📌 *Cómo usarme:*\n` +
    `• Mandame un CUIT para consultarlo\n` +
    `• Varios CUITs separados por espacio o coma\n\n` +
    `*Ejemplos:*\n` +
    `\`20123456789\`\n` +
    `\`20-12345678-9\`\n` +
    `\`20123456789, 27987654321\`\n\n` +
    `También podés usar:\n` +
    `/consultar 20123456789\n` +
    `/ayuda`,
    { parse_mode: "MarkdownV2" }
  );
});

bot.onText(/\/ayuda/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 *Ayuda*\n\n` +
    `*Situaciones crediticias:*\n` +
    `🟢 S1 — Normal \\(cumplimiento correcto\\)\n` +
    `🟡 S2 — Riesgo bajo \\(31–90 días de atraso\\)\n` +
    `🟠 S3 — Riesgo medio \\(91–180 días\\)\n` +
    `🔴 S4 — Riesgo alto \\(181–365 días\\)\n` +
    `⛔ S5 — Irrecuperable \\(\\+365 días / quiebra\\)\n` +
    `🔵 S6 — Irrecuperable técnica\n\n` +
    `*Comandos:*\n` +
    `/start — Inicio\n` +
    `/consultar \\[cuit\\] — Consultar un CUIT\n` +
    `/ayuda — Esta ayuda`,
    { parse_mode: "MarkdownV2" }
  );
});

bot.onText(/\/consultar (.+)/, async (msg, match) => {
  await procesarCUITs(msg.chat.id, match[1]);
});

// Mensaje de texto libre: detectar CUITs
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  await procesarCUITs(msg.chat.id, msg.text);
});

// ── Procesador central ───────────────────────────────────────────────────────
async function procesarCUITs(chatId, texto) {
  // Extraer todos los CUITs del texto
  const cuits = texto
    .split(/[\s,;|]+/)
    .map(parseCuit)
    .filter(c => c.length === 11);

  if (cuits.length === 0) {
    // Si hay números pero incompletos
    const hayNumeros = /\d/.test(texto);
    if (hayNumeros) {
      return bot.sendMessage(chatId,
        "⚠️ CUIT inválido\\. Debe tener 11 dígitos\\.\nEjemplo: `20123456789`",
        { parse_mode: "MarkdownV2" }
      );
    }
    return; // ignorar texto sin números
  }

  const unique = [...new Set(cuits)];

  if (unique.length > 10) {
    return bot.sendMessage(chatId, "⚠️ Máximo 10 CUITs por consulta\\.", { parse_mode: "MarkdownV2" });
  }

  // Mensaje de espera
  const espera = await bot.sendMessage(chatId,
    unique.length === 1
      ? `🔍 Consultando CUIT ${escapeMd(formatCuit(unique[0]))}\\.\\.\\. un momento`
      : `🔍 Consultando ${unique.length} CUITs\\.\\.\\. un momento`,
    { parse_mode: "MarkdownV2" }
  );

  // Consultar todos en paralelo
  const respuestas = await Promise.all(
    unique.map(async (cuit) => {
      try {
        const { deudores, cheques } = await consultarCUIT(cuit);
        return { cuit, deudores, cheques, error: null };
      } catch {
        return { cuit, error: "No se pudo consultar\\. Intentá de nuevo\\." };
      }
    })
  );

  // Borrar mensaje de espera
  try { await bot.deleteMessage(chatId, espera.message_id); } catch {}

  // Enviar cada resultado
  for (const r of respuestas) {
    if (r.error) {
      await bot.sendMessage(chatId,
        `❌ *CUIT ${escapeMd(formatCuit(r.cuit))}*\n${r.error}`,
        { parse_mode: "MarkdownV2" }
      );
    } else {
      const texto = armarRespuesta(r.cuit, r.deudores, r.cheques);
      await bot.sendMessage(chatId, texto, { parse_mode: "MarkdownV2" });
    }
    // Pequeña pausa entre mensajes si son varios
    if (respuestas.length > 1) await sleep(300);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

console.log("🤖 Bot BCRA iniciado y escuchando...");
