const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error("Falta BOT_TOKEN"); process.exit(1); }

// ── Lista blanca de usuarios autorizados ──────────────────────────────────────
// Se carga desde la variable de entorno ALLOWED_USERS (IDs separados por coma)
// Si la variable no está definida, el bot es abierto (para facilitar la configuración inicial)
const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? new Set(process.env.ALLOWED_USERS.split(",").map(id => id.trim()))
  : null;

function usuarioAutorizado(msg) {
  if (!ALLOWED_USERS) return true; // sin restricción si no se configuró
  const userId = String(msg.from?.id);
  return ALLOWED_USERS.has(userId);
}

function rechazarAcceso(chatId) {
  bot.sendMessage(chatId,
    "🔒 No tenes acceso a este bot.\nContacta al administrador."
  );
}

const bot = new TelegramBot(TOKEN, { polling: true });

const SITS = {
  1: { emoji: "🟢", label: "Normal" },
  2: { emoji: "🟡", label: "Riesgo bajo" },
  3: { emoji: "🟠", label: "Riesgo medio" },
  4: { emoji: "🔴", label: "Riesgo alto" },
  5: { emoji: "⛔", label: "Irrecuperable" },
  6: { emoji: "🔵", label: "Irrecup. Tecnica" },
};

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
  const timer = setTimeout(() => controller.abort(), 12000);
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
    console.error("fetchBCRA error:", e.message, url);
    return null;
  }
}

async function consultarCUIT(cuit) {
  const [deudores, cheques] = await Promise.all([
    fetchBCRA("https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/" + cuit),
    fetchBCRA("https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/ChequesRechazados/" + cuit),
  ]);
  return { deudores, cheques };
}

function armarRespuesta(cuit, deudores, cheques) {
  const fmt = formatCuit(cuit);
  const nombre = deudores?.results?.denominacion || cheques?.results?.denominacion || "";
  const periodos = deudores?.results?.periodos || [];
  // La estructura correcta es: results.causales[].entidades[].detalle[]
  const causales = cheques?.results?.causales || [];

  let lines = [];

  lines.push("🏦 CUIT: " + fmt);
  if (nombre) lines.push("👤 " + nombre);
  lines.push("");

  // ── Situacion crediticia ──
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
        if (e.monto) linea += "  " + formatMonto(e.monto * 1000); // viene en miles
        lines.push(linea);
      });
      lines.push("");
    });
  }

  lines.push("─────────────────────");

  // ── Cheques rechazados ──
  // Estructura: causales[{ causal, entidades[{ entidad, detalle[{nroCheque, fechaRechazo, monto, fechaPago, estadoMulta, denomJuridica}] }] }]
  if (causales.length > 0) {
    let totalCheques = 0;
    causales.forEach(c => c.entidades?.forEach(e => totalCheques += (e.detalle?.length || 0)));

    lines.push("🏦 Cheques rechazados: " + totalCheques);

    causales.forEach(causalObj => {
      const causal = causalObj.causal || "SIN FONDOS";
      (causalObj.entidades || []).forEach(entObj => {
        (entObj.detalle || []).forEach(ch => {
          lines.push("");
          lines.push("  Cheque N " + (ch.nroCheque || "-"));
          lines.push("  Causal: " + causal);
          if (ch.fechaRechazo) lines.push("  Fecha rechazo: " + ch.fechaRechazo);
          if (ch.monto) lines.push("  Monto: " + formatMonto(ch.monto));
          if (ch.denomJuridica) lines.push("  Empresa: " + ch.denomJuridica);
          if (ch.fechaPago) {
            lines.push("  Pagado: " + ch.fechaPago);
          } else {
            lines.push("  Estado: NO PAGADO");
          }
          if (ch.estadoMulta) lines.push("  Multa: " + ch.estadoMulta);
        });
      });
    });
  } else {
    lines.push("⚠️ La API no devolvio cheques rechazados.");
    lines.push("Si el cheque fue rechazado recientemente,");
    lines.push("puede demorar unos dias en aparecer.");
    lines.push("");
    lines.push("Verificar manualmente:");
    lines.push("https://www.bcra.gob.ar/cheques/actualiza.asp");
  }

  return lines.join("\n");
}

async function procesarCUITs(chatId, texto) {
  const cuits = texto.split(/[\s,;|]+/).map(parseCuit).filter(c => c.length === 11);

  if (cuits.length === 0) {
    if (/\d/.test(texto)) {
      return bot.sendMessage(chatId, "⚠️ CUIT invalido. Debe tener 11 digitos.\nEjemplo: 20123456789");
    }
    return;
  }

  const unique = [...new Set(cuits)];
  if (unique.length > 10) return bot.sendMessage(chatId, "⚠️ Maximo 10 CUITs por consulta.");

  const espera = await bot.sendMessage(chatId,
    unique.length === 1
      ? "🔍 Consultando CUIT " + formatCuit(unique[0]) + "... un momento"
      : "🔍 Consultando " + unique.length + " CUITs... un momento"
  );

  const respuestas = await Promise.all(
    unique.map(async (cuit) => {
      try {
        const { deudores, cheques } = await consultarCUIT(cuit);
        return { cuit, deudores, cheques, error: null };
      } catch(e) {
        console.error("Error consultando", cuit, e.message);
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
        const msg = armarRespuesta(r.cuit, r.deudores, r.cheques);
        await bot.sendMessage(chatId, msg);
      }
    } catch(e) {
      console.error("Error enviando mensaje:", e.message);
      await bot.sendMessage(chatId, "❌ Error al mostrar resultado de " + formatCuit(r.cuit));
    }
    if (respuestas.length > 1) await new Promise(r => setTimeout(r, 400));
  }
}

bot.onText(/\/start/, (msg) => {
  if (!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  const nombre = msg.from.first_name || "amigo";
  bot.sendMessage(msg.chat.id,
    "👋 Hola " + nombre + "!\n\n" +
    "Soy el bot de consulta del Central de Deudores del BCRA.\n\n" +
    "Manda un CUIT para consultarlo, o varios separados por espacio o coma.\n\n" +
    "Ejemplos:\n20123456789\n20-12345678-9\n20123456789, 27987654321\n\n" +
    "/ayuda para mas info"
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
    "Comandos: /start /ayuda /consultar [cuit]"
  );
});

bot.onText(/\/cheques (.+)/, async (msg, match) => {
  if (!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  const cuit = parseCuit(match[1]);
  if (cuit.length !== 11) return bot.sendMessage(msg.chat.id, "⚠️ CUIT invalido.");
  bot.sendMessage(msg.chat.id,
    "🔗 Consulta directa en el BCRA para " + formatCuit(cuit) + ":\n" +
    "https://www.bcra.gob.ar/cheques/actualiza.asp\n\n" +
    "(Ingresa el CUIT en el campo de busqueda)"
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

console.log("Bot BCRA iniciado...");
