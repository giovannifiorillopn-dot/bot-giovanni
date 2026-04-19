require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const crypto = require('crypto');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Sessões: { history, lastActivity, channel, phoneNumber, atendido }
const sessions = new Map();
// Números já atendidos por ligação (bot para de responder)
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

// ─── POST /chat ───────────────────────────────────────────
app.post('/chat', async (req, res) => {
  try {
    const { message, sessionId, channel = 'site', phoneNumber = '' } = req.body;
    if (!message || !sessionId) {
      return res.status(400).json({ error: 'message e sessionId são obrigatórios' });
    }

    // Se o número já foi atendido por ligação, bot não responde mais
    if (phoneNumber && atendidos.has(phoneNumber)) {
      return res.json({ reply: null, atendido: true });
    }

    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { history: [], lastActivity: Date.now(), channel, phoneNumber });

      // No WhatsApp, primeira mensagem do bot é sempre a apresentação padrão
      if (channel === 'whatsapp') {
        sessions.get(sessionId).history.push({
          role: 'assistant',
          content: PRIMEIRA_MENSAGEM_WHATSAPP
        });
        return res.json({ reply: PRIMEIRA_MENSAGEM_WHATSAPP, sessionId, primeiraVez: true });
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

    res.json({ reply, sessionId });
  } catch (err) {
    console.error('Erro Claude API:', err.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ─── POST /atendido ───────────────────────────────────────
// Chamado após o Dr. Giovanni realizar a ligação com o lead
// Body: { phoneNumber: "5531999991234" }
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
