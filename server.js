require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Estado persistente ───────────────────────────────────
// sessions: histórico de conversa (apenas em memória — aceitável)
// leadData, agendamentos, atendidos: salvos em arquivo

const sessions    = new Map();
const leadData    = new Map(); // phone → { nome, cidade }
const agendamentos = new Map(); // phone → { nome, cidade, turno, dataStr }
const atendidos   = new Set();
const etiquetados = new Set(); // phones com etiqueta no WhatsApp Business → bot ignora

const DATA_FILE = path.join(__dirname, 'leads.json');

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [k, v] of Object.entries(d.leads || {}))       leadData.set(k, v);
    for (const [k, v] of Object.entries(d.agendamentos || {})) agendamentos.set(k, v);
    for (const v of (d.atendidos || []))                       atendidos.add(v);
    for (const v of (d.etiquetados || []))                     etiquetados.add(v);
    console.log(`[Data] Carregado: ${leadData.size} leads, ${agendamentos.size} agendamentos, ${etiquetados.size} etiquetados`);
  } catch {
    console.log('[Data] Nenhum arquivo de dados encontrado — iniciando do zero.');
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      leads:        Object.fromEntries(leadData),
      agendamentos: Object.fromEntries(agendamentos),
      atendidos:    [...atendidos],
      etiquetados:  [...etiquetados],
    }, null, 2));
  } catch (e) {
    console.error('[Data] Erro ao salvar:', e.message);
  }
}

loadData();

// ─── Credenciais ──────────────────────────────────────────

const ZAPI_INSTANCE   = process.env.ZAPI_INSTANCE   || '3F1E5AEC4B777172FB89667E5D6D48C0';
const ZAPI_TOKEN      = process.env.ZAPI_TOKEN      || 'D58C616CC9F6B43FEA818D01';
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || 'Fd5068006066544898ed1d5606b9c7c35S';
const DR_PHONE        = process.env.DR_PHONE        || '5531971900140';

const TURNOS = {
  manha:  { label: 'Manhã (09:00 – 10:00)',  inicio: 9,  lembrete: { h: 8,  m: 40 } },
  tarde:  { label: 'Tarde (14:00 – 15:00)',  inicio: 14, lembrete: { h: 13, m: 40 } },
  noite:  { label: 'Noite (19:00 – 20:00)',  inicio: 19, lembrete: { h: 18, m: 40 } },
};

const DIAS_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

const lembretesEnviados = new Set();

// ─── Sessões expiradas (memória) ──────────────────────────
setInterval(() => {
  const limite = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.lastActivity < limite) sessions.delete(id);
  }
}, 30 * 60 * 1000);

// ─── Z-API helpers ────────────────────────────────────────

function zapiReq(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Client-Token': ZAPI_CLIENT_TOKEN };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const opts = {
      hostname: 'api.z-api.io',
      path: `/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}${endpoint}`,
      method,
      headers,
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function enviarMensagem(phone, message) {
  return zapiReq('POST', '/send-text', { phone: phone.replace(/\D/g, ''), message });
}
async function enviarVideo(phone, videoUrl, caption) {
  return zapiReq('POST', '/send-video', { phone: phone.replace(/\D/g, ''), video: videoUrl, caption: caption || '' });
}
async function enviarImagem(phone, imageUrl, caption) {
  return zapiReq('POST', '/send-image', { phone: phone.replace(/\D/g, ''), image: imageUrl, caption: caption || '' });
}

const VIDEO_TRICOSCOPIA = 'https://bot-giovanni-production.up.railway.app/tricoscopia.mp4';
const FOTOS_RESULTADOS  = Array.from({length: 9}, (_, i) =>
  `https://bot-giovanni-production.up.railway.app/resultado${i+1}.jpg`
);

// ─── Timezone BRT (UTC-3) ─────────────────────────────────

function getBRT() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}

function proximoSlot(turno) {
  const brt        = getBRT();
  const diaAtual   = brt.getUTCDay();
  const horaAtual  = brt.getUTCHours();
  const ehDiaUtil  = diaAtual >= 1 && diaAtual <= 5;
  const naoPassou  = horaAtual < TURNOS[turno].inicio;

  let diasAdicionar = 0;
  if (!ehDiaUtil || !naoPassou) {
    diasAdicionar = 1;
    let prox = (diaAtual + diasAdicionar) % 7;
    while (prox === 0 || prox === 6) { diasAdicionar++; prox = (diaAtual + diasAdicionar) % 7; }
  }

  const dataFinal = new Date(brt.getTime() + diasAdicionar * 24 * 60 * 60 * 1000);
  const d   = String(dataFinal.getUTCDate()).padStart(2, '0');
  const mes = String(dataFinal.getUTCMonth() + 1).padStart(2, '0');
  const ano = dataFinal.getUTCFullYear();
  return {
    label:   `${DIAS_PT[dataFinal.getUTCDay()]}, ${d}/${mes}`,
    dataStr: `${ano}-${mes}-${d}`,
  };
}

// ─── Lembrete 20 min antes de cada turno ─────────────────

async function enviarLembreteTurno(turno, dateStr) {
  const pendentes = [];
  for (const [phone, ag] of agendamentos) {
    if (ag.turno === turno && ag.dataStr === dateStr) pendentes.push({ phone, ...ag });
  }
  if (pendentes.length === 0) return;

  const lista = pendentes.map((a, i) => `${i+1}. *${a.nome}* — ${a.cidade} — ${a.phone}`).join('\n');
  await enviarMensagem(DR_PHONE,
    `⏰ *Lembrete de ligações — ${TURNOS[turno].label}*\n\nLeads para ligar agora:\n\n${lista}\n\n_Assistente virtual Dr. Giovanni_`
  );
  console.log(`[Lembrete] Enviado — turno ${turno} — ${pendentes.length} lead(s)`);
}

// ─── Polling: detecta saudações/despedidas do Dr. ────────
async function verificarMensagensRecentes() {
  const agora = Date.now();
  const janela = 3 * 60 * 1000; // mensagens dos últimos 3 minutos

  const leadsAtivos    = [...leadData.keys()].filter(p => !etiquetados.has(p) && !atendidos.has(p));
  const leadsEtiquetados = [...etiquetados];
  const phones = [...new Set([...leadsAtivos, ...leadsEtiquetados])];

  console.log(`[Polling] Verificando ${phones.length} lead(s) — ativos: ${leadsAtivos.length}, etiquetados: ${leadsEtiquetados.length}`);

  for (const phone of phones) {
    try {
      const msgs = await zapiReq('GET', `/chats/${phone}/messages?page=1&pageSize=10`, null);
      console.log(`[Polling DEBUG] ${phone}:`, JSON.stringify(msgs).slice(0, 400));
      if (!Array.isArray(msgs)) continue;

      for (const msg of msgs) {
        if (!msg.fromMe) continue;
        const ts = msg.momment || msg.timestamp || 0;
        const tsMs = ts > 1e12 ? ts : ts * 1000;
        if (agora - tsMs > janela) continue;

        const texto = msg.text?.message || msg.message || msg.body || '';
        const saudacoes = /\b(bom\s*dia|boa\s*tarde|boa\s*noite)\b/i;
        const despedidas = /\bat[eé]\s*logo\b/i;

        if (saudacoes.test(texto) && !etiquetados.has(phone)) {
          etiquetados.add(phone);
          saveData();
          console.log(`[Polling] Bot suspenso para ${phone} — saudação detectada.`);
          break;
        }
        if (despedidas.test(texto) && etiquetados.has(phone)) {
          etiquetados.delete(phone);
          saveData();
          console.log(`[Polling] Bot reativado para ${phone} — despedida detectada.`);
          break;
        }
      }
    } catch { /* silencioso */ }
  }
}

setInterval(() => {
  verificarMensagensRecentes().catch(() => {});
}, 90 * 1000);

setInterval(() => {
  const brt = getBRT();
  const dia = brt.getUTCDay();
  if (dia === 0 || dia === 6) return;
  const h = brt.getUTCHours();
  const m = brt.getUTCMinutes();
  const dateStr = brt.toISOString().slice(0, 10);

  for (const [turno, cfg] of Object.entries(TURNOS)) {
    const key = `${dateStr}_${turno}`;
    if (h === cfg.lembrete.h && m >= cfg.lembrete.m && m < cfg.lembrete.m + 2 && !lembretesEnviados.has(key)) {
      lembretesEnviados.add(key);
      enviarLembreteTurno(turno, dateStr).catch(e => console.error('[Lembrete] Erro:', e.message));
    }
  }
}, 30 * 1000);

// ─── Prompts ──────────────────────────────────────────────

function buildSystemPrompt(channel, phoneNumber) {
  const lead = leadData.get(phoneNumber);

  const canalInfo = channel === 'whatsapp'
    ? `\nCANAL: WhatsApp. O número do lead já é conhecido (${phoneNumber}). NÃO peça o WhatsApp.`
    : `\nCANAL: Site. Colete nome completo, WhatsApp e cidade de preferência (Ponte Nova ou Mariana).`;

  const dadosLead = lead
    ? `\nDADOS JÁ COLETADOS DESTE LEAD:\n- Nome: ${lead.nome}\n- Cidade: ${lead.cidade}\nNÃO peça nome ou cidade novamente. Use esses dados diretamente.\n`
    : `\nColete nome completo e cidade de preferência (Ponte Nova ou Mariana).\nQuando o lead informar nome e cidade pela primeira vez, inclua ao final da sua mensagem (invisível): [DADOS:nome completo:cidade]\n`;

  const slotManha = proximoSlot('manha');
  const slotTarde = proximoSlot('tarde');
  const slotNoite = proximoSlot('noite');

  const agLead = agendamentos.get(phoneNumber);
  const agendamentoInfo = agLead
    ? `\nAGENDAMENTO JÁ REALIZADO: ${agLead.nome} escolheu o turno ${TURNOS[agLead.turno].label} do dia ${agLead.dataStr}. NÃO ofereça horários novamente.\n`
    : `\nAGENDAMENTO DA LIGAÇÃO:\nApós coletar nome e cidade, pergunte qual faixa de horário fica melhor para receber a ligação do Dr. Giovanni:\n  - 1️⃣ *Manhã* — ${slotManha.label}, das 09:00 às 10:00\n  - 2️⃣ *Tarde* — ${slotTarde.label}, das 14:00 às 15:00\n  - 3️⃣ *Noite* — ${slotNoite.label}, das 19:00 às 20:00\n\nQuando o lead confirmar um turno, escreva confirmação calorosa com o DIA e HORÁRIO exatos e inclua ao final (invisível): [AGENDADO:turno:nome completo:cidade]\n(turno = manha | tarde | noite — use exatamente assim)\nUse a tag UMA ÚNICA VEZ por conversa.\n`;

  return `Você é o assistente virtual do Dr. Giovanni Fiorillo, especialista em tricologia e transplante capilar. Você representa a clínica com simpatia, profissionalismo e linguagem acolhedora. Sempre chame o lead pelo primeiro nome.

SOBRE O DR. GIOVANNI:
- Médico especialista em tricologia e transplante capilar
- Realiza CONSULTAS presenciais em Ponte Nova e Mariana (MG)
- A CIRURGIA de transplante capilar é realizada EXCLUSIVAMENTE em Ponte Nova (MG)
- Resultados densos e naturais — sem aspecto artificial
- Atende número limitado de pacientes por mês para garantir atenção individualizada

ENDEREÇOS:
- Ponte Nova: Avenida Francisco Vieira Martins, 460 — em frente aos Correios de Palmeiras, no ponto de táxi
- Mariana: Rua Santana, 101 — Centro Clínico Santana

SOBRE A CONSULTA:
- A consulta NÃO é gratuita
- É dividida em 3 etapas: avaliação do histórico clínico, tricoscopia da área doadora e planejamento cirúrgico/facial
- NÃO informe o valor da consulta — o Dr. Giovanni explica os valores e o que está incluso durante a ligação
- Atendimento particular. Emitimos nota fiscal para reembolso em convênio

SOBRE O PROCEDIMENTO E VALORES:
- NÃO informe valores, médias ou estimativas de preço em nenhuma circunstância
- Se perguntarem sobre preço: "O Dr. Giovanni explica todos os valores pessoalmente na ligação. Cada caso é único."

SOBRE A TRICOSCOPIA:
"O primeiro passo é realizar a análise da área doadora com a tricoscopia. Esse exame visualiza os fios e o couro cabeludo em tamanho aumentado, permitindo ao Dr. Giovanni montar o planejamento cirúrgico — definindo a técnica utilizada (FUE, BHT, entre outras) e a quantidade estimada de fios para cobertura da área."

ENVIO DE MÍDIA (uma vez por conversa cada tag):
- Ao explicar tricoscopia pela primeira vez → [VIDEO_TRICOSCOPIA] ao final
- Quando pedirem resultados/fotos/exemplos → [FOTOS_RESULTADOS] ao final
- Nunca use as duas na mesma mensagem.
${canalInfo}
${dadosLead}
${agendamentoInfo}
PRIMEIRA MENSAGEM (quando não há histórico anterior):
"Olá! 👋 Sou o assistente virtual do *Dr. Giovanni Fiorillo*, especialista em transplante capilar.

Sou um assistente virtual — não sou humano — mas estou aqui para te ajudar com duas coisas:

1️⃣ *Tirar suas dúvidas gerais* sobre o procedimento
2️⃣ *Agendar a sua ligação* com o Dr. Giovanni

Dúvidas mais superficiais eu consigo responder agora mesmo, por aqui. Já as dúvidas mais aprofundadas e específicas para o seu caso, o Dr. Giovanni esclarece pessoalmente na ligação. 😊

Para começar, qual é o seu nome?"

REGRAS:
- Seja objetivo e acolhedor. Máximo 3-4 frases por resposta
- Chame sempre pelo primeiro nome
- Não invente informações médicas
- Nunca mencione valores ou preços
- Atendimento é particular; pode emitir nota para reembolso em convênio
- Responda SEMPRE em português brasileiro`;
}

// ─── Lógica central do bot ────────────────────────────────

async function processarMensagem(message, sessionId, channel, phoneNumber) {
  if (phoneNumber && atendidos.has(phoneNumber)) {
    return { reply: null, atendido: true };
  }

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { history: [], lastActivity: Date.now(), channel, phoneNumber });
  }

  const session = sessions.get(sessionId);
  session.lastActivity = Date.now();
  session.history.push({ role: 'user', content: message });

  if (session.history.length > 40) session.history = session.history.slice(-40);

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: buildSystemPrompt(session.channel, session.phoneNumber),
    messages: session.history,
  });

  let reply = response.content[0].text;
  let enviarVideoTricoscopia = false;
  let enviarFotosResultados  = false;
  let agendado = null;
  let dadosColetados = null;

  if (reply.includes('[VIDEO_TRICOSCOPIA]')) {
    reply = reply.replace('[VIDEO_TRICOSCOPIA]', '').trim();
    enviarVideoTricoscopia = true;
  }
  if (reply.includes('[FOTOS_RESULTADOS]')) {
    reply = reply.replace('[FOTOS_RESULTADOS]', '').trim();
    enviarFotosResultados = true;
  }

  // Detecta coleta de nome+cidade
  const matchDados = reply.match(/\[DADOS:([^:]+):([^\]]+)\]/);
  if (matchDados) {
    const [fullTag, nome, cidade] = matchDados;
    reply = reply.replace(fullTag, '').trim();
    dadosColetados = { nome: nome.trim(), cidade: cidade.trim() };
  }

  // Detecta agendamento de turno
  const matchAgendado = reply.match(/\[AGENDADO:([^:]+):([^:]+):([^\]]+)\]/);
  if (matchAgendado) {
    const [fullTag, turno, nome, cidade] = matchAgendado;
    reply = reply.replace(fullTag, '').trim();
    if (TURNOS[turno]) {
      const { dataStr } = proximoSlot(turno);
      agendado = { turno, nome: nome.trim(), cidade: cidade.trim(), dataStr };
    }
  }

  session.history.push({ role: 'assistant', content: reply });

  return { reply, sessionId, enviarVideoTricoscopia, enviarFotosResultados, agendado, dadosColetados };
}

// ─── GET /qrcode ──────────────────────────────────────────
app.get('/qrcode', async (req, res) => {
  try {
    const status = await zapiReq('GET', '/status', null);
    if (status.connected) return res.json({ status: 'connected' });
    const qr = await zapiReq('GET', '/qr-code/image', null);
    if (qr.value) return res.json({ status: 'qr', qr: 'data:image/png;base64,' + qr.value });
    return res.json({ status: 'waiting' });
  } catch (e) { res.json({ status: 'error', message: e.message }); }
});

// ─── GET /wa-status ───────────────────────────────────────
app.get('/wa-status', async (req, res) => {
  try {
    const status = await zapiReq('GET', '/status', null);
    res.json({ status: status.connected ? 'connected' : 'disconnected' });
  } catch (e) { res.json({ status: 'disconnected' }); }
});

// ─── POST /webhook/zapi ───────────────────────────────────
app.post('/webhook/zapi', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  if (body.isGroup || body.isGroupMsg) return;

  console.log('[DEBUG webhook]', JSON.stringify(body).slice(0, 400));

  const phone = body.phone || body.from || '';
  const texto = body.text?.message || body.image?.caption || '';
  if (!phone || !texto.trim()) return;

  // Detecta mensagens do Dr. → suspende ou reativa bot para aquele lead
  if (body.fromMe) {
    const saudacoes = /\b(bom\s*dia|boa\s*tarde|boa\s*noite)\b/i;
    const despedidas = /\bat[eé]\s*logo\b/i;
    if (saudacoes.test(texto) && !etiquetados.has(phone)) {
      etiquetados.add(phone);
      saveData();
      console.log(`[Saudação] Bot suspenso para ${phone} — Dr. iniciou atendimento humano.`);
    } else if (despedidas.test(texto) && etiquetados.has(phone)) {
      etiquetados.delete(phone);
      saveData();
      console.log(`[Despedida] Bot reativado para ${phone} — Dr. encerrou atendimento humano.`);
    }
    return;
  }

  // Ignora contatos com etiqueta (WhatsApp Business labels) — atendimento humano
  const temEtiquetaNoPayload = (body.labels?.length > 0) || (body.labelIds?.length > 0);
  if (temEtiquetaNoPayload && !etiquetados.has(phone)) {
    etiquetados.add(phone);
    saveData();
    console.log(`[Etiqueta] ${phone} adicionado automaticamente via payload.`);
  }
  if (etiquetados.has(phone)) {
    console.log(`[Etiqueta] Ignorando ${phone} — contato etiquetado (atendimento humano).`);
    return;
  }

  console.log(`[Z-API] ${phone}: ${texto.slice(0, 80)}`);

  try {
    const result = await processarMensagem(texto, `wa_${phone}`, 'whatsapp', phone);

    if (result.reply) {
      await enviarMensagem(phone, result.reply);
    }

    if (result.dadosColetados) {
      leadData.set(phone, result.dadosColetados);
      saveData();
      console.log(`[Lead] Dados salvos: ${result.dadosColetados.nome} / ${result.dadosColetados.cidade}`);
    }

    if (result.agendado) {
      agendamentos.set(phone, result.agendado);
      // garante que leadData também esteja salvo
      if (!leadData.has(phone)) {
        leadData.set(phone, { nome: result.agendado.nome, cidade: result.agendado.cidade });
      }
      saveData();
      console.log(`[Agendamento] ${result.agendado.nome} — ${result.agendado.turno} ${result.agendado.dataStr}`);
    }

    if (result.enviarVideoTricoscopia) {
      await new Promise(r => setTimeout(r, 1500));
      await enviarVideo(phone, VIDEO_TRICOSCOPIA, '');
    }
    if (result.enviarFotosResultados) {
      for (let i = 0; i < FOTOS_RESULTADOS.length; i++) {
        await new Promise(r => setTimeout(r, 1000));
        await enviarImagem(phone, FOTOS_RESULTADOS[i], i === 0 ? 'Alguns resultados do Dr. Giovanni Fiorillo 👇' : '');
      }
    }
  } catch (e) {
    console.error('[Z-API] Erro:', e.message);
  }
});

// ─── POST /chat (site) ────────────────────────────────────
app.post('/chat', async (req, res) => {
  try {
    const { message, sessionId, channel = 'site', phoneNumber = '' } = req.body;
    if (!message || !sessionId) return res.status(400).json({ error: 'message e sessionId são obrigatórios' });
    const result = await processarMensagem(message, sessionId, channel, phoneNumber);
    res.json(result);
  } catch (err) {
    console.error('Erro Claude API:', err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ─── POST /webhook/zapi-enviadas ─────────────────────────
// Webhook "Ao enviar" do Z-API — detecta saudações/despedidas do Dr.
app.post('/webhook/zapi-enviadas', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  console.log('[DEBUG enviadas]', JSON.stringify(body).slice(0, 400));

  const phone = (body.phone || body.to || '').replace(/\D/g, '');
  const messageId = body.messageId || body.id;
  if (!phone || !messageId) return;

  try {
    const msg = await zapiReq('GET', `/messages/${messageId}`, null);
    console.log('[DEBUG msg]', JSON.stringify(msg).slice(0, 400));

    const texto = msg?.text?.message || msg?.message || msg?.body || msg?.caption || '';
    if (!texto.trim()) return;

    const saudacoes = /\b(bom\s*dia|boa\s*tarde|boa\s*noite)\b/i;
    const despedidas = /\bat[eé]\s*logo\b/i;

    if (saudacoes.test(texto) && !etiquetados.has(phone)) {
      etiquetados.add(phone);
      saveData();
      console.log(`[Enviadas] Bot suspenso para ${phone} — Dr. iniciou atendimento humano.`);
    } else if (despedidas.test(texto) && etiquetados.has(phone)) {
      etiquetados.delete(phone);
      saveData();
      console.log(`[Enviadas] Bot reativado para ${phone} — Dr. encerrou atendimento humano.`);
    }
  } catch (e) {
    console.error('[Enviadas] Erro ao buscar mensagem:', e.message);
  }
});

// ─── POST /webhook/zapi-etiquetas ────────────────────────
// Configurar no Z-API: webhook "Ao atualizar etiqueta"
app.post('/webhook/zapi-etiquetas', (req, res) => {
  res.sendStatus(200);
  const { phone, action } = req.body;
  if (!phone) return;

  const phoneClean = phone.replace(/\D/g, '');
  if (action === 'remove') {
    etiquetados.delete(phoneClean);
    console.log(`[Etiqueta] ${phoneClean} removido — bot voltará a responder.`);
  } else {
    // action === 'add' ou qualquer outro valor
    etiquetados.add(phoneClean);
    console.log(`[Etiqueta] ${phoneClean} marcado — bot irá ignorar.`);
  }
  saveData();
});

// ─── POST /etiquetado ─────────────────────────────────────
app.post('/etiquetado', (req, res) => {
  const { phoneNumber, remover } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber obrigatório' });
  if (remover) {
    etiquetados.delete(phoneNumber);
    saveData();
    return res.json({ ok: true, acao: 'removido', phoneNumber });
  }
  etiquetados.add(phoneNumber);
  saveData();
  console.log(`[Etiqueta] ${phoneNumber} marcado manualmente.`);
  res.json({ ok: true, acao: 'adicionado', phoneNumber });
});

// ─── GET /etiquetados ─────────────────────────────────────
app.get('/etiquetados', (req, res) => res.json({ etiquetados: [...etiquetados] }));

// ─── POST /atendido ───────────────────────────────────────
app.post('/atendido', (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber obrigatório' });
  atendidos.add(phoneNumber);
  agendamentos.delete(phoneNumber);
  saveData();
  console.log(`Lead ${phoneNumber} marcado como atendido.`);
  res.json({ ok: true, phoneNumber });
});

// ─── GET /atendidos ───────────────────────────────────────
app.get('/atendidos', (req, res) => res.json({ atendidos: [...atendidos] }));

// ─── GET /agendamentos ────────────────────────────────────
app.get('/agendamentos', (req, res) => {
  const por_turno = { manha: [], tarde: [], noite: [] };
  for (const [phone, ag] of agendamentos) {
    if (por_turno[ag.turno]) por_turno[ag.turno].push({ phone, ...ag });
  }
  res.json({ total: agendamentos.size, por_turno });
});

// ─── GET /session ─────────────────────────────────────────
app.get('/session', (req, res) => res.json({ sessionId: crypto.randomUUID() }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot do Dr. Giovanni rodando em http://localhost:${PORT}`);
});
