const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error("Falta BOT_TOKEN"); process.exit(1); }

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
  return "$" + Number(m).toLocaleString("es-AR");
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
    console.error("fetchBCRA error:", url, e.message);
    return null;
  }
}

async function consultarCUIT(cuit) {
  // Consultamos los 4 endpoints posibles en paralelo
  const [deudores, chequesV1, chequesDeudor, chequesHistorico] = await Promise.all([
    fetchBCRA("https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/" + cuit),
    fetchBCRA("https://api.bcra.gob.ar/cheques/v1.0/deudores/" + cuit),
    fetchBCRA("https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/ChequesRechazados/" + cuit),
    fetchBCRA("https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/Historicas/" + cuit),
  ]);

  // Unificar cheques de todos los endpoints
  let todosLosCheques = [];

  // Endpoint cheques v1
  if (chequesV1?.results?.length > 0) {
    todosLosCheques = todosLosCheques.concat(chequesV1.results);
  }
  // Endpoint cheques rechazados central deudores
  if (chequesDeudor?.results?.length > 0) {
    todosLosCheques = todosLosCheques.concat(chequesDeudor.results);
  }
  // A veces vienen en el historico
  if (chequesHistorico?.results?.chequesRechazados?.length > 0) {
    todosLosCheques = todosLosCheques.concat(chequesHistorico.results.chequesRechazados);
  }

  // Log para debug
  console.log("CUIT:", cuit);
  console.log("chequesV1:", JSON.stringify(chequesV1)?.slice(0, 200));
  console.log("chequesDeudor:", JSON.stringify(chequesDeudor)?.slice(0, 200));
  console.log("chequesHistorico:", JSON.stringify(chequesHistorico)?.slice(0, 200));

  return { deudores, cheques: todosLosCheques, rawCheques: { chequesV1, chequesDeudor, chequesHistorico } };
}

function armarRespuesta(cuit, deudores, cheques, rawCheques) {
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
        if (e.monto) linea += "  " + formatMonto(e.monto);
        lines.push(linea);
      });
      lines.push("");
    });
  }

  lines.push("─────────────────────");

  // Cheques rechazados
  if (cheques.length > 0) {
    lines.push("🏦 Cheques rechazados: " + cheques.length);
    cheques.slice(0, 15).forEach(ch => {
      lines.push("");
      // Intentar todos los nombres posibles de campos
      const nro = ch.nroCheque || ch.numeroCheque || ch.numero || ch.nro || "-";
      const fecha = ch.fechaRechazo || ch.fecha || ch.fechaProcesamiento || "";
      const monto = ch.monto || ch.importe || null;
      const motivo = ch.motivoRechazo || ch.motivo || ch.causal || "";
      const entidad = ch.entidad || ch.banco || ch.nombreEntidad || "";
      const cuenta = ch.cuenta || ch.nroCuenta || "";

      lines.push("  Cheque N " + nro);
      if (fecha) lines.push("  Fecha: " + fecha);
      if (entidad) lines.push("  Entidad: " + entidad);
      if (cuenta) lines.push("  Cuenta: " + cuenta);
      if (monto) lines.push("  Monto: " + formatMonto(monto));
      if (motivo) lines.push("  Motivo: " + motivo);
    });
    if (cheques.length > 15) {
      lines.push("");
      lines.push("  ... y " + (cheques.length - 15) + " mas");
    }
  } else {
    lines.push("⚠️ Sin cheques rechazados en los registros del BCRA.");
    lines.push("(Si tenes el detalle del rechazo, puede ser de una camara compensadora no reportada aun)");
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
        const { deudores, cheques, rawCheques } = await consultarCUIT(cuit);
        return { cuit, deudores, cheques, rawCheques, error: null };
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
        const msg = armarRespuesta(r.cuit, r.deudores, r.cheques, r.rawCheques);
        await bot.sendMessage(chatId, msg);
      }
    } catch(e) {
      console.error("Error enviando mensaje:", e.message);
      await bot.sendMessage(chatId, "❌ Error mostrando resultado del CUIT " + formatCuit(r.cuit) + ". Error: " + e.message);
    }
    if (respuestas.length > 1) await new Promise(r => setTimeout(r, 400));
  }
}

bot.onText(/\/start/, (msg) => {
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
  bot.sendMessage(msg.chat.id,
    "📖 Situaciones crediticias:\n\n" +
    "🟢 S1 - Normal\n🟡 S2 - Riesgo bajo (31-90 dias)\n🟠 S3 - Riesgo medio (91-180 dias)\n" +
    "🔴 S4 - Riesgo alto (181-365 dias)\n⛔ S5 - Irrecuperable\n🔵 S6 - Irrecuperable tecnica\n\n" +
    "Comandos: /start /ayuda /consultar [cuit]"
  );
});

bot.onText(/\/consultar (.+)/, async (msg, match) => {
  await procesarCUITs(msg.chat.id, match[1]);
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  await procesarCUITs(msg.chat.id, msg.text);
});

bot.on("polling_error", (err) => console.error("Polling error:", err.message));

console.log("Bot BCRA iniciado...");
