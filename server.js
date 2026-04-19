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

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || '3F1E5AEC4B777172FB89667E5D6D48C0';
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || 'D58C616CC9F6B43FEA818D01';
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || 'Fd5068006066544898ed1d5606b9c7c35S';
const ZAPI_BASE = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`;

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

const VIDEO_TRICOSCOPIA = 'https://bot-giovanni-production.up.railway.app/tricoscopia.mp4';

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

ENVIO DE VÍDEO:
- Quando explicar a tricoscopia pela primeira vez, inclua exatamente ao final da sua mensagem: [VIDEO_TRICOSCOPIA]
- Use apenas uma vez por conversa. Não inclua em outras situações.
${canalInfo}

SEU PAPEL:
1. Recepcionar o lead pelo nome com simpatia e profissionalismo
2. Coletar nome completo e cidade de preferência (e WhatsApp se for pelo site)
3. Informar que o Dr. Giovanni entrará em contato por ligação no WhatsApp em breve
4. ENQUANTO O DR. AINDA NÃO LIGOU: engajar o lead com perguntas sobre sua situação capilar:
   - Pergunte se ele já realizou a tricoscopia (análise da área doadora)
   - Pergunte há quanto tempo percebe a queda
   - Pergunte como está a situação atual (início, área considerável, calvície avançada)
   - Se ele nunca fez tricoscopia, explique a importância usando o texto acima
5. Mantenha a conversa aquecida e o lead engajado até o Dr. Giovanni realizar a ligação

REGRAS IMPORTANTES:
- Seja objetivo e acolhedor. Máximo 3-4 frases por resposta
- Chame sempre pelo primeiro nome
- Não invente informações médicas — se não souber, diga que o Dr. Giovanni esclarecerá na ligação
- Nunca mencione valores, preços ou estimativas de custo (consulta ou procedimento)
- Não marque horários — o agendamento é feito pela equipe após a ligação do Dr.
- Atendimento é particular; pode emitir nota para reembolso em convênio (se perguntarem)
- Responda SEMPRE em português brasileiro`;
}

const PRIMEIRA_MENSAGEM_WHATSAPP = `Olá! 👋 Sou o assistente virtual do *Dr. Giovanni Fiorillo*, especialista em tricologia e transplante capilar.

O Dr. Giovanni já foi notificado do seu contato e entrará em contato com você por ligação no WhatsApp em breve. 📱

Enquanto isso, me conta uma coisa: o senhor já realizou a análise da sua área doadora com a *tricoscopia*?`;

// ─── Lógica central do bot ────────────────────────────────

async function processarMensagem(message, sessionId, channel, phoneNumber) {
  if (phoneNumber && atendidos.has(phoneNumber)) {
    return { reply: null, atendido: true };
  }

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { history: [], lastActivity: Date.now(), channel, phoneNumber });

    if (channel === 'whatsapp') {
      sessions.get(sessionId).history.push({
        role: 'assistant',
        content: PRIMEIRA_MENSAGEM_WHATSAPP
      });
      return { reply: PRIMEIRA_MENSAGEM_WHATSAPP, sessionId, primeiraVez: true };
    }
  }

  const session = sessions.get(sessionId);
  session.lastActivity = Date.now();
  session.history.push({ role: 'user', content: message });

  if (session.history.length > 40) {
    session.history = session.history.slice(-40);
  }

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: buildSystemPrompt(session.channel, session.phoneNumber),
    messages: session.history,
  });

  let reply = response.content[0].text;
  let enviarVideoTricoscopia = false;

  if (reply.includes('[VIDEO_TRICOSCOPIA]')) {
    reply = reply.replace('[VIDEO_TRICOSCOPIA]', '').trim();
    enviarVideoTricoscopia = true;
  }

  session.history.push({ role: 'assistant', content: reply });

  return { reply, sessionId, enviarVideoTricoscopia };
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
    if (result.enviarVideoTricoscopia) {
      await new Promise(r => setTimeout(r, 1500));
      await enviarVideo(phone, VIDEO_TRICOSCOPIA, '');
      console.log(`[Z-API] Vídeo tricoscopia enviado para ${phone}`);
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
  console.log(`Lead ${phoneNumber} marcado como atendido.`);
  res.json({ ok: true, phoneNumber });
});

// ─── GET /atendidos ───────────────────────────────────────
app.get('/atendidos', (req, res) => {
  res.json({ atendidos: [...atendidos] });
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
