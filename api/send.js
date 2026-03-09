const { Resend }   = require('resend');
const { put, del } = require('@vercel/blob');

const resend      = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL  = process.env.FROM_EMAIL    || 'PostCardiB <onboarding@resend.dev>';
const REPLY_TO    = process.env.REPLY_TO_EMAIL;   // no hardcoded fallback
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ── Validation constants ───────────────────────────────────────────────────
const EMAIL_RE        = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;   // 4 MB base64 string length
const MAX_NAME_LEN    = 100;
const MAX_MESSAGE_LEN = 2000;

// Allowed image MIME types (must match data URI prefix)
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MIME_RE      = /^data:(image\/(?:jpeg|png|webp|gif));base64,/;

// ── Rate limiting (module-level, best-effort per serverless instance) ──────
const rateMap = new Map();   // ip → { count, resetAt }
const RATE_LIMIT  = 5;       // max requests per window
const RATE_WINDOW = 60_000;  // 60 seconds

function isRateLimited(ip) {
  const now   = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  return false;
}

// ── Handler ───────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // CORS — restrict to deployed origin in production
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed.' });

  // Rate limit by IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }

  const { to, recipientName, senderName, message, imageBase64 } = req.body || {};

  // ── Input validation ────────────────────────────────────────────────────
  if (!to || typeof to !== 'string')
    return res.status(400).json({ error: 'Recipient email is required.' });

  if (!EMAIL_RE.test(to.trim()))
    return res.status(400).json({ error: 'Invalid recipient email address.' });

  if (!imageBase64 || typeof imageBase64 !== 'string')
    return res.status(400).json({ error: 'Postcard image is required.' });

  // Validate image MIME type from data URI
  const mimeMatch = imageBase64.match(MIME_RE);
  if (!mimeMatch || !ALLOWED_MIME.includes(mimeMatch[1]))
    return res.status(400).json({ error: 'Invalid image type. Use JPG, PNG, WEBP or GIF.' });

  if (imageBase64.length > MAX_IMAGE_BYTES)
    return res.status(413).json({ error: 'Image is too large. Please use a smaller photo.' });

  if (recipientName && recipientName.length > MAX_NAME_LEN)
    return res.status(400).json({ error: 'Recipient name is too long.' });

  if (senderName && senderName.length > MAX_NAME_LEN)
    return res.status(400).json({ error: 'Sender name is too long.' });

  if (message && message.length > MAX_MESSAGE_LEN)
    return res.status(400).json({ error: 'Message is too long (max 2000 characters).' });

  // ── Process ─────────────────────────────────────────────────────────────
  const detectedMime = mimeMatch[1];
  const base64Data   = imageBase64.replace(MIME_RE, '');
  const imageBuffer  = Buffer.from(base64Data, 'base64');

  // Sanitise text inputs with correct max lengths
  const safeRecipient = sanitise(recipientName, MAX_NAME_LEN);
  const safeSender    = sanitise(senderName,    MAX_NAME_LEN);
  const safeMessage   = sanitise(message,       MAX_MESSAGE_LEN);
  const safeTo        = to.trim().toLowerCase();

  let blobUrl = null;
  try {
    // 1. Upload image to Vercel Blob
    const ext  = detectedMime.split('/')[1];
    const blob = await put(`postcards/${Date.now()}.${ext}`, imageBuffer, {
      access:      'public',
      contentType: detectedMime,
    });
    blobUrl = blob.url;

    // 2. Send email
    const emailPayload = {
      from:    FROM_EMAIL,
      to:      [safeTo],
      subject: `📮 A Postcard for you${safeRecipient ? ', ' + safeRecipient : ''} — PostCardiB`,
      html:    buildEmailHTML({
        recipientName: safeRecipient,
        senderName:    safeSender,
        message:       safeMessage,
        to:            safeTo,
        imageUrl:      blobUrl,
      }),
    };
    if (REPLY_TO) emailPayload.reply_to = REPLY_TO;

    const { data, error } = await resend.emails.send(emailPayload);
    if (error) throw new Error(error.message);

    // 3. Delete blob after 1 hour (fire-and-forget)
    setTimeout(() => del(blobUrl).catch(() => {}), 60 * 60 * 1000);

    return res.status(200).json({ success: true, id: data?.id });

  } catch (err) {
    console.error('[PostCardiB] send error:', err.message);
    if (blobUrl) del(blobUrl).catch(() => {});
    return res.status(500).json({ error: 'Failed to send. Please try again.' });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────
function sanitise(s = '', maxLen = 100) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .slice(0, maxLen);
}

function buildEmailHTML({ recipientName, senderName, message, to, imageUrl }) {
  const msg = (message || '(No message on the back.)')
    .slice(0, MAX_MESSAGE_LEN)
    .split('\n').join('<br>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>A Postcard for You — PostCardiB</title>
</head>
<body style="margin:0;padding:0;background:#FFF9F0;font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:580px;margin:0 auto;padding:0 0 48px;">

  <div style="height:6px;background:repeating-linear-gradient(-45deg,#C62828 0,#C62828 9px,#FFB300 9px,#FFB300 18px);"></div>

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#7F0000;border-bottom:4px solid #FFB300;">
    <tr>
      <td style="padding:14px 22px;">
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="width:46px;height:46px;background:#FFB300;border-radius:50%;text-align:center;vertical-align:middle;font-size:1.4rem;">📮</td>
          <td style="padding-left:12px;vertical-align:middle;">
            <div style="color:#fff;font-size:1.35rem;font-weight:bold;letter-spacing:3px;">PostCardiB</div>
            <div style="color:#FFB300;font-size:0.66rem;letter-spacing:1.5px;font-style:italic;margin-top:3px;">Your Digital Post Office</div>
          </td>
        </tr></table>
      </td>
      <td style="text-align:right;padding:14px 22px;color:rgba(255,255,255,0.55);font-size:0.6rem;letter-spacing:2px;">✦ DIGITAL POST ✦</td>
    </tr>
  </table>

  <div style="background:#fff;padding:14px 14px 8px;box-shadow:0 4px 20px rgba(0,0,0,0.14);margin:24px 20px 0;border-top:7px solid #C62828;">
    <img src="${imageUrl}" alt="Your Postcard" width="100%" style="display:block;max-width:100%;border:0;"/>
    <div style="text-align:right;padding:5px 2px 2px;font-size:0.56rem;color:#BDBDBD;letter-spacing:3px;text-transform:uppercase;">PostCardiB · Digital Post</div>
  </div>

  <div style="background:#fff;margin:0 20px;border-left:4px solid #C62828;box-shadow:0 2px 8px rgba(0,0,0,0.07);">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#C62828;">
      <tr>
        <td style="padding:7px 16px;color:#fff;font-size:0.88rem;letter-spacing:4px;text-transform:uppercase;">Post Card</td>
        <td style="text-align:right;padding:7px 16px;color:rgba(255,255,255,0.65);font-size:0.58rem;letter-spacing:1px;">✦ DIGITAL POST ✦</td>
      </tr>
    </table>
    <div style="padding:20px 22px 16px;background-image:linear-gradient(#FFCDD2 1px,transparent 1px);background-size:100% 28px;background-position:0 10px;">
      <p style="font-family:'Courier New',Courier,monospace;font-size:0.92rem;color:#1A1A1A;line-height:2;margin:0;">${msg}</p>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #FFCDD2;background:#FFF9F0;">
      <tr>
        <td style="padding:12px 22px;">
          <div style="font-size:0.58rem;color:#BDBDBD;letter-spacing:2px;text-transform:uppercase;margin-bottom:3px;">To</div>
          <div style="font-family:'Courier New',Courier,monospace;font-size:0.86rem;color:#1A1A1A;">${recipientName || to}</div>
        </td>
        <td style="padding:12px 22px;text-align:right;">
          <div style="font-size:0.58rem;color:#BDBDBD;letter-spacing:2px;text-transform:uppercase;margin-bottom:3px;">From</div>
          <div style="font-family:'Courier New',Courier,monospace;font-size:0.86rem;color:#1A1A1A;">${senderName || 'A Friend'}</div>
        </td>
      </tr>
    </table>
  </div>

  <div style="margin:28px 20px 0;text-align:center;">
    <div style="height:3px;background:repeating-linear-gradient(90deg,#C62828 0 6px,#FFB300 6px 12px);margin-bottom:14px;"></div>
    <p style="font-size:0.6rem;color:#BDBDBD;letter-spacing:2px;text-transform:uppercase;margin:0;">Sent with love via PostCardiB · Your Digital Post Office</p>
  </div>

</div>
</body>
</html>`;
}
