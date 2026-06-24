const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fetch = require('node-fetch');
const pino = require('pino');
const http = require('http');
const qrcode = require('qrcode');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const SYSTEM_PROMPT = `أنت مساعد خدمة عملاء لشركة عقارات في قطر متخصصة في بيع وإيجار الاستوديوهات والشقق (غرفة وصالة).

قواعدك:
1. رحّب بكل عميل جديد بـ: "وعليكم السلام ورحمة الله 🏠 أهلاً وسهلاً بك في شركتنا العقارية! سيتواصل معك أحد موظفينا قريباً إن شاء الله."
2. إذا سأل عن الأسعار أو تفاصيل الوحدات، قل: "سيتواصل معك أحد موظفينا في أقرب وقت للإجابة على استفساراتك 🙏"
3. إذا تكلم بشكل عام، استمر معه بأسلوب ودي ومحترم.
4. تكلم دائماً بالعربية.
5. لا تعطِ أسعاراً محددة أو تفاصيل وحدات بنفسك.
6. كن مختصراً ولطيفاً في ردودك.`;

let currentQR = null;
let isConnected = false;

// صفحة ويب تعرض QR Code
const server = http.createServer(async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (isConnected) {
    res.end('<h2 style="color:green;text-align:center;margin-top:100px">✅ البوت متصل وشغّال!</h2>');
  } else if (currentQR) {
    const qrImage = await qrcode.toDataURL(currentQR);
    res.end(`
      <html><body style="text-align:center;font-family:Arial">
      <h2>امسح QR Code بواتساب</h2>
      <img src="${qrImage}" style="width:300px"/>
      <p>واتساب ← النقاط الثلاث ← الأجهزة المرتبطة ← ربط جهاز</p>
      <script>setTimeout(()=>location.reload(),15000)</script>
      </body></html>
    `);
  } else {
    res.end('<h2 style="text-align:center;margin-top:100px">⏳ جاري التحميل... أعد تحديث الصفحة</h2>');
  }
});

server.listen(process.env.PORT || 3000, () => {
  console.log('✅ الصفحة شغّالة');
});

async function getAIResponse(userMessage, chatHistory) {
  const messages = [...chatHistory, { role: 'user', content: userMessage }];
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama3-8b-8192',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      max_tokens: 300,
      temperature: 0.7
    })
  });
  const data = await response.json();
  return data.choices[0].message.content;
}

const chatHistories = {};

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      console.log('📱 افتح الرابط وامسح QR Code');
    }
    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('✅ البوت متصل!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (!text) return;

    if (!chatHistories[from]) chatHistories[from] = [];
    try {
      const reply = await getAIResponse(text, chatHistories[from]);
      chatHistories[from].push({ role: 'user', content: text });
      chatHistories[from].push({ role: 'assistant', content: reply });
      if (chatHistories[from].length > 20) chatHistories[from] = chatHistories[from].slice(-20);
      await sock.sendMessage(from, { text: reply });
    } catch (err) {
      console.error('خطأ:', err);
    }
  });
}

connectToWhatsApp();
