require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
const atendidos = new Set();

setInterval(() => {
  const limite = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, session] of sessions) {
    if (session.lastActivity < limite) sessions.delete(id);
  }
}, 30 * 60 * 1000);

// ─── Prompts ──────────────────────────────────────────────

function buildSystemPrompt(channel, phoneNumber) {
  const canalInfo = channel === 'whatsapp'
    ? `\nCANAL: WhatsApp. O número do lead já é conhecido (${phoneNumber}). NÃO peça o WhatsApp. Colete apenas nome completo e cidade de preferência (Ponte Nova ou Mariana).`
    : `\nCANAL: Site. Colete nome completo, WhatsApp e cidade de preferência (Ponte Nova ou Mariana).`;

  return `Você é o assistente virtual do Dr. Giovanni Fiorillo, especialista em tricologia e transplante capilar.

SOBRE O DR. GIOVANNI:
- Médico especialista em tricologia e transplante capilar
- Atende presencialmente em Ponte Nova e Mariana (MG)
- Resultados densos e naturais — sem aspecto artificial
- Atende número limitado de pacientes por mês para garantir atenção individualizada

SOBRE O PROCEDIMENTO E VALORES:
- O valor do transplante capilar depende exclusivamente do planejamento terapêutico individualizado de cada paciente
- Para definir o planejamento, é realizada a análise da área doadora em tamanho aumentado (tricoscopia)
- Com base nessa análise, o Dr. Giovanni define a melhor técnica (FUE, BHT, entre outras) e a quantidade estimada de fios
- Portanto, NÃO informe valores, médias ou estimativas de preço em nenhuma circunstância
- Se o lead perguntar sobre preço, explique que o valor depende do planejamento terapêutico e que o Dr. Giovanni apresentará todas as informações na consulta
${canalInfo}

SEU PAPEL:
1. Recepcionar o lead com simpatia e profissionalismo
2. Coletar nome completo e cidade de preferência (e WhatsApp se for pelo site)
3. Informar que o Dr. Giovanni entrará em contato por ligação no WhatsApp em breve
4. ENQUANTO O DR. AINDA NÃO LIGOU: engajar o lead com perguntas sobre sua situação capilar
   - Pergunte se ele já realizou a análise da área doadora com tricoscopia
   - Pergunte há quanto tempo está percebendo a queda de cabelo
   - Pergunte como está a situação atual (início da queda, área considerável, calvície avançada)
   - Responda dúvidas sobre o procedimento sem mencionar valores
5. Mantenha a conversa aquecida e o lead engajado até o Dr. Giovanni realizar a ligação

REGRAS IMPORTANTES:
- Seja objetivo e acolhedor. Máximo 3-4 frases por resposta
- Não invente informações médicas. Se não souber algo, diga que o Dr. Giovanni esclarecerá na ligação
- Nunca mencione valores, preços ou estimativas de custo
- Não marque horários fixos — o Dr. Giovanni liga quando possível
- Responda SEMPRE em português brasileiro`;
}

const PRIMEIRA_MENSAGEM_WHATSAPP = `Olá! 👋 Sou o assistente virtual do *Dr. Giovanni Fiorillo*, especialista em tricologia e transplante capilar.

O Dr. Giovanni já foi notificado do seu contato e entrará em contato com você por ligação no WhatsApp em breve. 📱

Enquanto isso, me conta uma coisa: o senhor já realizou a análise da sua área doadora com a *tricoscopia*?`;

// ─── Função de envio via Evolution API ───────────────────

function enviarWhatsApp(numero, texto) {
  const EVOLUTION_URL = process.env.EVOLUTION_API_URL;
  const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;
  const INSTANCE = process.env.EVOLUTION_INSTANCE || 'giovanni';

  if (!EVOLUTION_URL || !EVOLUTION_KEY) {
    console.log('[WhatsApp] Evolution API não configurada');
    return;
  }

  const body = JSON.stringify({ number: numero, text: texto, options: { delay: 1200 } });
  const url = new URL(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`);
  const lib = url.protocol === 'https:' ? https : http;

  const req = lib.request({
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': EVOLUTION_KEY,
      'Content-Length': Buffer.byteLength(body)
    },
    rejectUnauthorized: false
  }, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => console.log(`[WhatsApp] Enviado para ${numero}:`, res.statusCode));
  });
  req.on('error', e => console.error('[WhatsApp] Erro envio:', e.message));
  req.write(body); req.end();
}

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

  const reply = response.content[0].text;
  session.history.push({ role: 'assistant', content: reply });

  return { reply, sessionId };
}

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

// ─── POST /webhook/whatsapp (Evolution API) ───────────────
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);

  try {
    console.log('[Webhook] Recebido:', JSON.stringify(req.body).slice(0, 300));

    const body = req.body;
    const event = body.event || body.type || '';

    // Aceita tanto 'messages.upsert' quanto 'MESSAGES_UPSERT'
    const isMessage = event.toLowerCase().includes('messages') && event.toLowerCase().includes('upsert');
    if (!isMessage) return;

    // data pode ser objeto ou array (depende da versão da Evolution API)
    const rawData = body.data;
    const items = Array.isArray(rawData) ? rawData : [rawData];

    for (const data of items) {
      if (!data || !data.key) continue;
      if (data.key.fromMe) continue;

      const remoteJid = data.key.remoteJid || '';
      if (remoteJid.includes('@g.us')) continue; // ignora grupos

      // Suporta @s.whatsapp.net e @lid (formato novo WhatsApp)
      const numero = remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '');
      const texto =
        data.message?.conversation ||
        data.message?.extendedTextMessage?.text ||
        data.message?.imageMessage?.caption ||
        data.body ||
        '';

      if (!texto.trim()) continue;

      console.log(`[WhatsApp] Mensagem de ${numero} (${remoteJid}): ${texto}`);

      const result = await processarMensagem(texto, `wa_${numero}`, 'whatsapp', numero);
      if (result.reply) {
        // Usa o remoteJid completo para garantir entrega correta
        enviarWhatsApp(remoteJid, result.reply);
      }
    }
  } catch (err) {
    console.error('[Webhook] Erro:', err.message);
  }
});

// ─── POST /atendido ───────────────────────────────────────
app.post('/atendido', (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber obrigatório' });
  atendidos.add(phoneNumber);
  console.log(`Lead ${phoneNumber} marcado como atendido. Bot não responderá mais.`);
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
});
