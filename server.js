require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
const atendidos = new Set();
const agendamentos = new Map(); // phone → { nome, cidade, turno }
const lembretesEnviados = new Set(); // 'YYYY-MM-DD_turno' — evita reenvio

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || '3F1E5AEC4B777172FB89667E5D6D48C0';
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || 'D58C616CC9F6B43FEA818D01';
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || 'Fd5068006066544898ed1d5606b9c7c35S';
const DR_PHONE = process.env.DR_PHONE || '5531971900140';

const TURNOS = {
  manha:  { label: 'Manhã (09:00 – 10:00)',   lembrete: { h: 8,  m: 40 } },
  tarde:  { label: 'Tarde (14:00 – 15:00)',    lembrete: { h: 13, m: 40 } },
  noite:  { label: 'Noite (19:00 – 20:00)',    lembrete: { h: 18, m: 40 } },
};

// ─── Sessões expiradas ────────────────────────────────────
setInterval(() => {
  const limite = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, session] of sessions) {
    if (session.lastActivity < limite) sessions.delete(id);
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
  const clean = phone.replace(/\D/g, '');
  return zapiReq('POST', '/send-text', { phone: clean, message });
}

async function enviarVideo(phone, videoUrl, caption) {
  const clean = phone.replace(/\D/g, '');
  return zapiReq('POST', '/send-video', { phone: clean, video: videoUrl, caption: caption || '' });
}

async function enviarImagem(phone, imageUrl, caption) {
  const clean = phone.replace(/\D/g, '');
  return zapiReq('POST', '/send-image', { phone: clean, image: imageUrl, caption: caption || '' });
}

const VIDEO_TRICOSCOPIA = 'https://bot-giovanni-production.up.railway.app/tricoscopia.mp4';
const FOTOS_RESULTADOS = Array.from({length: 9}, (_, i) =>
  `https://bot-giovanni-production.up.railway.app/resultado${i+1}.jpg`
);

// ─── Lembrete 20 min antes de cada turno ─────────────────

function getBRT() {
  // Railway roda em UTC; Brasil é UTC-3
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}

async function enviarLembreteTurno(turno, dateStr) {
  const pendentes = [];
  for (const [phone, ag] of agendamentos) {
    if (ag.turno === turno) pendentes.push({ phone, ...ag });
  }

  if (pendentes.length === 0) {
    console.log(`[Lembrete] Nenhum agendado para o turno ${turno} de ${dateStr}`);
    return;
  }

  const lista = pendentes.map((a, i) =>
    `${i + 1}. *${a.nome}* — ${a.cidade} — ${a.phone}`
  ).join('\n');

  const msg =
    `⏰ *Lembrete de ligações — ${TURNOS[turno].label}*\n\n` +
    `Leads para ligar agora:\n\n${lista}\n\n` +
    `_Assistente virtual Dr. Giovanni_`;

  await enviarMensagem(DR_PHONE, msg);
  console.log(`[Lembrete] Enviado para Dr. Giovanni — turno ${turno} — ${pendentes.length} lead(s)`);
}

setInterval(() => {
  const brt = getBRT();
  const diaSemana = brt.getUTCDay(); // 0=Dom, 6=Sab
  if (diaSemana === 0 || diaSemana === 6) return;

  const h = brt.getUTCHours();
  const m = brt.getUTCMinutes();
  const dateStr = brt.toISOString().slice(0, 10);

  for (const [turno, cfg] of Object.entries(TURNOS)) {
    const key = `${dateStr}_${turno}`;
    // janela de 2 minutos para absorver drift do setInterval
    if (h === cfg.lembrete.h && m >= cfg.lembrete.m && m < cfg.lembrete.m + 2 && !lembretesEnviados.has(key)) {
      lembretesEnviados.add(key);
      enviarLembreteTurno(turno, dateStr).catch(e =>
        console.error(`[Lembrete] Erro ao enviar turno ${turno}:`, e.message)
      );
    }
  }
}, 30 * 1000);

// ─── Prompts ──────────────────────────────────────────────

function buildSystemPrompt(channel, phoneNumber) {
  const canalInfo = channel === 'whatsapp'
    ? `\nCANAL: WhatsApp. O número do lead já é conhecido (${phoneNumber}). NÃO peça o WhatsApp. Colete apenas nome completo e cidade de preferência (Ponte Nova ou Mariana).`
    : `\nCANAL: Site. Colete nome completo, WhatsApp e cidade de preferência (Ponte Nova ou Mariana).`;

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
- O valor do transplante depende do planejamento terapêutico individualizado de cada paciente
- NÃO informe valores, médias ou estimativas de preço em nenhuma circunstância — nem da consulta, nem do procedimento
- Se perguntarem sobre preço, diga: "O Dr. Giovanni explica todos os valores pessoalmente na ligação. Cada caso é único e merece atenção individualizada."

SOBRE A TRICOSCOPIA (use esse texto quando explicar):
"O primeiro passo é realizar a análise da área doadora com a tricoscopia. Esse exame visualiza os fios e o couro cabeludo em tamanho aumentado, permitindo ao Dr. Giovanni montar o planejamento cirúrgico — definindo a técnica utilizada (FUE, BHT, entre outras) e a quantidade estimada de fios para cobertura da área."

ENVIO DE MÍDIA (use apenas uma vez por conversa cada tag):
- Quando explicar a tricoscopia pela primeira vez → inclua ao final: [VIDEO_TRICOSCOPIA]
- Quando o lead perguntar sobre resultados, fotos ou quiser ver exemplos → inclua ao final: [FOTOS_RESULTADOS]
- Nunca use as duas tags na mesma mensagem. Nunca mencione que vai enviar fotos/vídeo antes de usar a tag.
${canalInfo}

AGENDAMENTO DA LIGAÇÃO:
Após coletar o nome completo e a cidade do lead, pergunte qual faixa de horário fica melhor para receber a ligação do Dr. Giovanni. Os turnos disponíveis são de segunda a sexta-feira:
  - 1️⃣ Manhã — das 09:00 às 10:00
  - 2️⃣ Tarde — das 14:00 às 15:00
  - 3️⃣ Noite — das 19:00 às 20:00

Quando o lead confirmar um turno, escreva uma mensagem de confirmação calorosa e inclua no FINAL da mensagem (invisível para o lead) a tag:
[AGENDADO:turno:nome completo:cidade]

Onde "turno" é exatamente uma das palavras: manha | tarde | noite

Exemplos:
- Se escolheu manhã: [AGENDADO:manha:Carlos Oliveira:Ponte Nova]
- Se escolheu tarde: [AGENDADO:tarde:Ana Lima:Mariana]
- Se escolheu noite: [AGENDADO:noite:José Santos:Ponte Nova]

Use a tag UMA ÚNICA VEZ por conversa, apenas no momento da confirmação. Nunca repita.

PRIMEIRA MENSAGEM (quando não há histórico anterior):
Se for a primeira vez que o lead entra em contato, responda assim:
"Olá! 👋 Sou o assistente virtual do *Dr. Giovanni Fiorillo*, especialista em tricologia e transplante capilar.

O Dr. Giovanni já foi notificado do seu contato e entrará em contato com você por ligação no WhatsApp em breve. 📱

Enquanto isso, me conta uma coisa: o senhor já realizou a análise da sua área doadora com a *tricoscopia*?"

SEU PAPEL:
1. Recepcionar o lead com simpatia e profissionalismo
2. Coletar nome completo e cidade de preferência (e WhatsApp se for pelo site)
3. Engajar o lead com perguntas sobre sua situação capilar
4. Perguntar e confirmar o turno de preferência para a ligação
5. Manter a conversa aquecida até o Dr. Giovanni ligar

REGRAS IMPORTANTES:
- Seja objetivo e acolhedor. Máximo 3-4 frases por resposta
- Chame sempre pelo primeiro nome
- Não invente informações médicas — se não souber, diga que o Dr. Giovanni esclarecerá na ligação
- Nunca mencione valores, preços ou estimativas de custo (consulta ou procedimento)
- Atendimento é particular; pode emitir nota para reembolso em convênio (se perguntarem)
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

  if (session.history.length > 40) {
    session.history = session.history.slice(-40);
  }

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: buildSystemPrompt(session.channel, session.phoneNumber),
    messages: session.history,
  });

  let reply = response.content[0].text;
  let enviarVideoTricoscopia = false;
  let agendado = null;

  if (reply.includes('[VIDEO_TRICOSCOPIA]')) {
    reply = reply.replace('[VIDEO_TRICOSCOPIA]', '').trim();
    enviarVideoTricoscopia = true;
  }

  let enviarFotosResultados = false;
  if (reply.includes('[FOTOS_RESULTADOS]')) {
    reply = reply.replace('[FOTOS_RESULTADOS]', '').trim();
    enviarFotosResultados = true;
  }

  const matchAgendado = reply.match(/\[AGENDADO:([^:]+):([^:]+):([^\]]+)\]/);
  if (matchAgendado) {
    const [fullTag, turno, nome, cidade] = matchAgendado;
    reply = reply.replace(fullTag, '').trim();
    if (TURNOS[turno]) {
      agendado = { turno, nome: nome.trim(), cidade: cidade.trim() };
    }
  }

  session.history.push({ role: 'assistant', content: reply });

  return { reply, sessionId, enviarVideoTricoscopia, enviarFotosResultados, agendado };
}

// ─── GET /qrcode ──────────────────────────────────────────
app.get('/qrcode', async (req, res) => {
  try {
    const status = await zapiReq('GET', '/status', null);
    if (status.connected) return res.json({ status: 'connected' });

    const qr = await zapiReq('GET', '/qr-code/image', null);
    if (qr.value) return res.json({ status: 'qr', qr: 'data:image/png;base64,' + qr.value });

    return res.json({ status: 'waiting' });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// ─── GET /wa-status ───────────────────────────────────────
app.get('/wa-status', async (req, res) => {
  try {
    const status = await zapiReq('GET', '/status', null);
    res.json({ status: status.connected ? 'connected' : 'disconnected' });
  } catch (e) {
    res.json({ status: 'disconnected' });
  }
});

// ─── POST /webhook/zapi (mensagens recebidas) ─────────────
app.post('/webhook/zapi', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  if (body.fromMe) return;
  if (body.isGroup || body.isGroupMsg) return;

  const phone = body.phone || body.from || '';
  const texto = body.text?.message || body.image?.caption || '';
  if (!phone || !texto.trim()) return;

  console.log(`[Z-API] Mensagem de ${phone}: ${texto.slice(0, 80)}`);

  try {
    const result = await processarMensagem(texto, `wa_${phone}`, 'whatsapp', phone);

    if (result.reply) {
      await enviarMensagem(phone, result.reply);
      console.log(`[Z-API] Resposta enviada para ${phone}`);
    }

    if (result.agendado) {
      const { turno, nome, cidade } = result.agendado;
      agendamentos.set(phone, { nome, cidade, turno });
      console.log(`[Agendamento] ${nome} (${cidade}) — turno ${turno} — ${phone}`);
    }

    if (result.enviarVideoTricoscopia) {
      await new Promise(r => setTimeout(r, 1500));
      await enviarVideo(phone, VIDEO_TRICOSCOPIA, '');
      console.log(`[Z-API] Vídeo tricoscopia enviado para ${phone}`);
    }

    if (result.enviarFotosResultados) {
      for (let i = 0; i < FOTOS_RESULTADOS.length; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const caption = i === 0 ? 'Alguns resultados do Dr. Giovanni Fiorillo 👇' : '';
        await enviarImagem(phone, FOTOS_RESULTADOS[i], caption);
      }
      console.log(`[Z-API] Fotos de resultados enviadas para ${phone}`);
    }
  } catch (e) {
    console.error('[Z-API] Erro ao responder:', e.message);
  }
});

// ─── POST /chat (site) ────────────────────────────────────
app.post('/chat', async (req, res) => {
  try {
    const { message, sessionId, channel = 'site', phoneNumber = '' } = req.body;
    if (!message || !sessionId) {
      return res.status(400).json({ error: 'message e sessionId são obrigatórios' });
    }
    const result = await processarMensagem(message, sessionId, channel, phoneNumber);
    res.json(result);
  } catch (err) {
    console.error('Erro Claude API:', err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ─── POST /atendido ───────────────────────────────────────
app.post('/atendido', (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber obrigatório' });
  atendidos.add(phoneNumber);
  agendamentos.delete(phoneNumber); // remove da fila de ligações
  console.log(`Lead ${phoneNumber} marcado como atendido.`);
  res.json({ ok: true, phoneNumber });
});

// ─── GET /atendidos ───────────────────────────────────────
app.get('/atendidos', (req, res) => {
  res.json({ atendidos: [...atendidos] });
});

// ─── GET /agendamentos ────────────────────────────────────
app.get('/agendamentos', (req, res) => {
  const lista = [];
  for (const [phone, ag] of agendamentos) {
    lista.push({ phone, ...ag });
  }
  // agrupa por turno
  const por_turno = { manha: [], tarde: [], noite: [] };
  for (const ag of lista) {
    if (por_turno[ag.turno]) por_turno[ag.turno].push(ag);
  }
  res.json({ total: lista.length, por_turno });
});

// ─── GET /session ─────────────────────────────────────────
app.get('/session', (req, res) => {
  res.json({ sessionId: crypto.randomUUID() });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot do Dr. Giovanni rodando em http://localhost:${PORT}`);
  console.log(`Z-API instance: ${ZAPI_INSTANCE}`);
});
