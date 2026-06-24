const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fetch = require('node-fetch');
const pino = require('pino');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const SYSTEM_PROMPT = `أنت مساعد خدمة عملاء لشركة عقارات في قطر متخصصة في بيع وإيجار الاستوديوهات والشقق (غرفة وصالة).

قواعدك:
1. رحّب بكل عميل جديد بـ: "وعليكم السلام ورحمة الله 🏠 أهلاً وسهلاً بك في شركتنا العقارية! سيتواصل معك أحد موظفينا قريباً إن شاء الله."
2. إذا سأل عن الأسعار أو تفاصيل الوحدات، قل: "سيتواصل معك أحد موظفينا في أقرب وقت للإجابة على استفساراتك 🙏"
3. إذا تكلم بشكل عام، استمر معه بأسلوب ودي ومحترم.
4. تكلم دائماً بالعربية.
5. لا تعطِ أسعاراً محددة أو تفاصيل وحدات بنفسك.
6. كن مختصراً ولطيفاً في ردودك.`;

async function getAIResponse(userMessage, chatHistory) {
  const messages = [
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama3-8b-8192',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages
      ],
      max_tokens: 300,
      temperature: 0.7
    })
  });

  const data = await response.json();
  return data.choices[0].message.content;
}

// تخزين سجل المحادثات
const chatHistories = {};

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('❌ الاتصال انقطع، إعادة الاتصال:', shouldReconnect);
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      console.log('✅ البوت شغّال وجاهز!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

    if (!text) return;

    console.log(`📩 رسالة من ${from}: ${text}`);

    // تهيئة سجل المحادثة
    if (!chatHistories[from]) chatHistories[from] = [];

    try {
      const reply = await getAIResponse(text, chatHistories[from]);

      // حفظ المحادثة (آخر 10 رسائل فقط)
      chatHistories[from].push({ role: 'user', content: text });
      chatHistories[from].push({ role: 'assistant', content: reply });
      if (chatHistories[from].length > 20) chatHistories[from] = chatHistories[from].slice(-20);

      await sock.sendMessage(from, { text: reply });
      console.log(`✅ رد: ${reply}`);
    } catch (err) {
      console.error('خطأ:', err);
    }
  });
}

connectToWhatsApp();
