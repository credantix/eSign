import { createServer as http } from 'node:http';
import { createServer as https } from 'node:https';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { templatePdf, templates } from './pdf.mjs';
import { mockProvider } from './mock-provider.mjs';
import { configureZohoMail } from './zoho-mail.mjs';

const env = process.env;
const zohoMail = await configureZohoMail(env);
const pendingAcceptanceEmails = new Set();
const mode = env.ESIGN_MODE ?? 'mock';
if (!['mock', 'live'].includes(mode)) throw Error('ESIGN_MODE must be mock or live');
const port = Number(env.PORT ?? 8787);
const host = mode === 'mock' ? '127.0.0.1' : (env.HOST ?? '127.0.0.1');
const tls = !!(env.TLS_KEY && env.TLS_CERT);
let origin = new URL(env.PUBLIC_ORIGIN || ((tls ? 'https' : 'http') + '://127.0.0.1:' + (port || 8787))).origin;
const owner = env.SENDER_USER ?? 'sender';
const displayName = env.SENDER_NAME ?? 'Agreement Workspace';
const password = env.SENDER_PASSWORD ?? (mode === 'mock' ? randomBytes(15).toString('base64url') : '');
if (mode === 'live' && (!tls || !origin.startsWith('https:') || !env.DATA_KEY || password.length < 20 || !env.ESP_ADAPTER)) {
  throw Error('Live mode requires TLS, HTTPS PUBLIC_ORIGIN, DATA_KEY, a strong sender password and ESP_ADAPTER');
}
const adapter = mode === 'live' ? (await import(pathToFileURL(resolve(env.ESP_ADAPTER)).href)).default : null;
if (mode === 'live' && (!adapter || typeof adapter.start !== 'function' || typeof adapter.verify !== 'function')) {
  throw Error('ESP adapter must implement start and verify');
}
const data = resolve(env.DATA_DIR ?? 'data');
mkdirSync(data, { recursive: true, mode: 0o700 });
const keyFile = resolve(data, 'mock.key');
if (!env.DATA_KEY) {
  try { writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
const key = env.DATA_KEY ? Buffer.from(env.DATA_KEY, 'base64') : readFileSync(keyFile);
if (key.length !== 32) throw Error('DATA_KEY must decode to 32 bytes');
const derive = label => createHmac('sha256', key).update(label).digest();
const storageKey = derive('accord storage v1');
const linkKey = derive('accord link v1');
const mock = mode === 'mock' ? mockProvider(derive('accord mock signer v1')) : null;
const db = new DatabaseSync(resolve(data, 'accord.sqlite'));
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const query = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const mac = value => createHmac('sha256', linkKey).update(value).digest('base64url');
function seal(value, context) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', storageKey, nonce);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
}
function open(value, context) {
  const bytes = Buffer.from(value);
  const cipher = createDecipheriv('aes-256-gcm', storageKey, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
}
const pack = (value, context) => seal(JSON.stringify(value), context);
const unpack = (value, context) => JSON.parse(open(value, context));
function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
const status = row => row.status !== 'Signed' && Date.now() >= row.expires ? 'Expired' : row.status;
const get = id => query('SELECT id,owner,expires,details,status FROM agreements WHERE id=?', id);
const detail = row => unpack(row.details, row.id + ':details');
const evidence = row => unpack(row.evidence, row.id + ':attempt');
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const nameKey = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function audit(req, id, type, extra = {}) {
  const previous = query('SELECT entry FROM audit WHERE agreement=? ORDER BY seq DESC LIMIT 1', id);
  const entry = { type, at: new Date().toISOString(), ip: req.socket.remoteAddress, ...extra,
    previous: previous ? digest(previous.entry) : null };
  run('INSERT INTO audit(agreement,entry) VALUES(?,?)', id, pack(entry, id + ':audit:' + entry.previous));
}
function auditEntries(id) {
  let previous = null;
  return all('SELECT entry FROM audit WHERE agreement=? ORDER BY seq', id).map(row => {
    const entry = unpack(row.entry, id + ':audit:' + previous);
    previous = digest(row.entry);
    return { ...entry, entryHash: previous };
  });
}
function send(res, code, value, headers = {}) {
  if (Buffer.isBuffer(value)) res.writeHead(code, headers).end(value);
  else res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(value));
}
async function body(req, max = 15_000_000) {
  if (Number(req.headers['content-length']) > max) fail(413, 'Request too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) fail(413, 'Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function json(req, max) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) fail(415, 'Expected JSON');
  try { return JSON.parse(await body(req, max)) ?? {}; }
  catch (error) { if (error.code) throw error; fail(400, 'Invalid JSON'); }
}
function sender(req, res) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ') || !equal(Buffer.from(header.slice(6), 'base64'), Buffer.from(owner + ':' + password))) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Accord Sender"');
    fail(401, 'Sender authentication required');
  }
}
function recipient(req) {
  const [value, signature, ...extra] = (req.headers.authorization ?? '').replace(/^Bearer /, '').split('.');
  if (!signature || extra.length || !equal(mac(value), signature)) fail(401, 'Invalid signing link');
  const payload = JSON.parse(Buffer.from(value, 'base64url'));
  const row = get(payload.id);
  if (!row || row.expires !== payload.exp || Date.now() >= payload.exp) fail(410, 'This signing link has expired');
  return row;
}
function link(row) {
  const value = Buffer.from(JSON.stringify({ id: row.id, exp: row.expires })).toString('base64url');
  return origin + '/review#' + value + '.' + mac(value);
}
function pdf(row, field) {
  const bytes = query('SELECT original,final FROM agreements WHERE id=?', row.id)[field];
  if (!bytes) fail(404, 'PDF is unavailable');
  const decoded = open(bytes, row.id + ':' + field);
  const expected = detail(row)[field === 'original' ? 'sha256' : 'finalSha256'];
  if (digest(decoded) !== expected) fail(409, 'PDF integrity check failed');
  return decoded;
}
const pdfHeaders = { 'Content-Type': 'application/pdf' };
const publicInfo = row => { const info = detail(row); return { id: row.id, ...info, expires: row.expires, status: info.declinedAt ? 'Declined' : status(row) }; };
const decisions = ['Accept agreement', 'Decline agreement'];
const settlementOptions = ['Option 1', 'Option 2', 'Option 3'];
const consentText = 'I have reviewed this agreement and consent to sign this exact document electronically.';
const normalizePdf = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(400, 'Upload a valid PDF');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > 10_000_000 || !bytes.subarray(0, 8).toString().startsWith('%PDF-') ||
      !bytes.subarray(-2048).includes(Buffer.from('%%EOF'))) fail(400, 'Upload a PDF up to 10 MB');
  return bytes;
};
async function create(req) {
  const input = await json(req);
  const title = clean(input.title, 160), name = clean(input.name, 120);
  const email = clean(input.email, 254), phone = clean(input.phone, 24);
  const hours = Number(input.hours ?? 24);
  if (!title || !name || (!email && !phone) || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
      (phone && !/^\+?[0-9]{8,15}$/.test(phone)) || !Number.isInteger(hours) || hours < 1 || hours > 72) {
    fail(400, 'Provide a title, recipient, valid email or phone, and a link lifetime of 1 to 72 hours');
  }
  const terms = clean(input.terms, 20000);
  if (!input.pdf && (!Object.hasOwn(templates, input.template) || !terms || /[^\x20-\x7e\n\r\t]/.test(title + name + displayName + terms))) {
    fail(400, 'Choose a template and use plain English characters in its title, names and terms, or upload a PDF');
  }
  const bytes = input.pdf ? normalizePdf(input.pdf) : templatePdf(title, displayName, name, input.template, terms.replaceAll('\r', '').replaceAll('\t', ' '));
  const id = randomUUID(), expires = Date.now() + hours * 3600000;
  const details = { title, name, email, phone, sender: displayName, created: new Date().toISOString(),
    sha256: digest(bytes), matchName: input.matchName === true };
  transaction(() => {
    run('INSERT INTO agreements VALUES(?,?,?,?,?,NULL,?)', id, owner, expires, pack(details, id + ':details'), seal(bytes, id + ':original'), 'Sent');
    audit(req, id, 'link_created', { documentSha256: details.sha256, expires: new Date(expires).toISOString(), consent: false });
  });
  return { ...publicInfo(get(id)), link: link({ id, expires }) };
}

async function initiate(req, row) {
  const input = await json(req, 16384);
  if (input.reviewed !== true || input.consent !== true) fail(400, 'Review and consent are required');
  if (status(row) !== 'Viewed') fail(409, 'Open the PDF before starting a signing attempt');
  if (input.decision !== decisions[0]) fail(400, 'Select Accept agreement to proceed');
  if (!settlementOptions.includes(input.settlementOption)) fail(400, 'Select a settlement option');
  if (detail(row).declinedAt) fail(409, 'Agreement was declined');
  const original = pdf(row, 'original');
  const info = detail(row);
  const id = randomUUID(), expires = Math.min(row.expires, Date.now() + 600000);
  const initial = { decision: input.decision, settlementOption: input.settlementOption, documentSha256: info.sha256, signingDigest: info.sha256, mode, requestedAt: new Date().toISOString() };
  if (adapter) {
    const prepared = await adapter.start({ attemptId: id, expires, original, settlementOption: initial.settlementOption, documentSha256: info.sha256,
      callbackUrl: origin + '/api/esign/callback', returnUrl: origin + '/review' });
    if (!/^[a-f0-9]{64}$/.test(prepared.signingDigest) || new URL(prepared.redirectUrl).protocol !== 'https:') {
      fail(502, 'Invalid provider response');
    }
    initial.signingDigest = prepared.signingDigest;
    initial.providerState = prepared.state;
    initial.redirectUrl = prepared.redirectUrl;
  }
  transaction(() => {
    if (['Signed', 'Expired'].includes(status(get(row.id))) || Date.now() >= expires) fail(409, 'Agreement is no longer signable');
    run('INSERT INTO attempts VALUES(?,?,?,NULL,?)', id, row.id, expires, pack(initial, id + ':attempt'));
    audit(req, row.id, 'consent_received', { attemptId: id, consent: true, consentText, decision: initial.decision, settlementOption: initial.settlementOption, reviewed: true, documentSha256: info.sha256 });
  });
  return { attemptId: id, expires, redirectUrl: initial.redirectUrl, mode };
}
async function callback(req) {
  const raw = await body(req);
  let result, response;
  if (mock) {
    try { response = JSON.parse(raw); result = mock.verify(response); } catch { /* invalid response */ }
  } else {
    // The adapter authenticates the raw provider response before trusting transaction identifiers.
    result = await adapter.verify({ raw, headers: req.headers, lookup: id => {
      const attempt = query('SELECT * FROM attempts WHERE id=?', id);
      if (!attempt) return null;
      const row = get(attempt.agreement);
      return { ...evidence(attempt), original: pdf(row, 'original'), expires: attempt.expires };
    } });
  }
  if (!result || typeof result.attemptId !== 'string' || typeof result.eventId !== 'string' ||
      !result.eventId || result.eventId.length > 200 || typeof result.signerName !== 'string') fail(403, 'Provider evidence could not be verified');
  return transaction(() => {
    const attempt = query('SELECT * FROM attempts WHERE id=?', result.attemptId);
    if (!attempt) fail(404, 'Unknown signing attempt');
    if (attempt.last_event === result.eventId) return { status: 'Signed', replay: true };
    if (query('SELECT id FROM attempts WHERE last_event=?', result.eventId)) fail(409, 'Event already processed');
    const row = get(attempt.agreement);
    if (Date.now() >= attempt.expires || ['Signed', 'Expired'].includes(status(row))) fail(409, 'Signing attempt is closed');
    const initial = evidence(attempt);
    if (mock && initial.settlementOption !== result.settlementOption) fail(409, 'Settlement option mismatch');
    if (initial.mode !== mode || initial.signingDigest !== result.signingDigest) fail(409, 'Signing digest mismatch');
    const info = detail(row);
    if (info.matchName && nameKey(info.name) !== nameKey(result.signerName)) {
      audit(req, row.id, 'signer_mismatch', { attemptId: attempt.id, eventId: result.eventId });
      return { status: 'Rejected', reason: 'Signer name did not match' };
    }
    const original = pdf(row, 'original');
    const final = mock ? Buffer.concat([original, Buffer.from('\n% ACCORD SANDBOX - detached test evidence ' + response.message + ' ' + response.signature + '\n')])
      : result.signedPdf;
    if (!Buffer.isBuffer(final) || !final.length) fail(502, 'Missing verified signed PDF');
    if (info.declinedAt) fail(409, 'Agreement was declined');
    info.debtor = { name: result.signerName, source: mode === 'mock' ? 'Sandbox signer' : 'Verified signing certificate' };
    info.decision = initial.decision;
    info.settlementOption = initial.settlementOption;
    info.finalSha256 = digest(final);
    info.signatureMode = mode;
    run('UPDATE agreements SET status=?,details=?,final=? WHERE id=?', 'Signed', pack(info, row.id + ':details'), seal(final, row.id + ':final'), row.id);
    run('UPDATE attempts SET last_event=?,evidence=? WHERE id=?', result.eventId,
      pack({ ...initial, signerName: result.signerName, receipt: result.receipt ?? response }, attempt.id + ':attempt'), attempt.id);
    audit(req, row.id, 'signed', { attemptId: attempt.id, eventId: result.eventId, consent: true, settlementOption: initial.settlementOption, mode,
      signingDigest: result.signingDigest, finalSha256: info.finalSha256 });
    return { status: 'Signed' };
  });
}

const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/review', ['index.html', 'text/html']], ['/sandbox', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
]);
async function simulate(req, row) {
  if (!mock) fail(404, 'Sandbox unavailable');
  const input = await json(req, 4096);
  const attempt = query('SELECT * FROM attempts WHERE id=? AND agreement=?', clean(input.attemptId, 80), row.id);
  const signerName = clean(input.signerName, 120);
  if (!attempt || !signerName) fail(400, 'A signing attempt and test signer name are required');
  const response = mock.respond({ attemptId: attempt.id, eventId: randomUUID(), signerName, settlementOption: evidence(attempt).settlementOption, signingDigest: evidence(attempt).signingDigest });
  if (!tls) {
    const responseFromCallback = await fetch('http://127.0.0.1:' + app.address().port + '/api/esign/callback', {
      method: 'POST', body: JSON.stringify(response), signal: AbortSignal.timeout(5000),
    });
    const result = await responseFromCallback.json();
    if (!responseFromCallback.ok) fail(responseFromCallback.status, result.error);
    return result;
  }
  // In HTTPS mode the local adapter dispatches the signed envelope directly to the same callback handler.
  const event = Object.assign((async function* () { yield Buffer.from(JSON.stringify(response)); })(),
    { headers: {}, socket: { remoteAddress: 'sandbox-provider' } });
  return callback(event);
}
async function route(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (tls) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const pathname = new URL(req.url, origin).pathname;
  const method = req.method;
  const asset = assets.get(pathname);
  if (method === 'GET' && asset) {
    if (pathname === '/') sender(req, res);
    return send(res, 200, readFileSync(new URL('./public/' + asset[0], import.meta.url)), { 'Content-Type': asset[1] + '; charset=utf-8' });
  }
  if (pathname === '/api/esign/callback' && method === 'POST') return send(res, 200, await callback(req));
  if (method === 'POST' && req.headers['x-accord-request'] !== '1') fail(403, 'Missing application request header');
  if (pathname === '/api/agreements') {
    sender(req, res);
    if (method === 'GET') return send(res, 200, { mode, sender: displayName,
      agreements: all('SELECT id,owner,expires,details,status FROM agreements WHERE owner=? ORDER BY rowid DESC', owner)
        .map(row => ({ ...publicInfo(row), link: ['Expired', 'Signed', 'Declined'].includes(publicInfo(row).status) ? null : link(row) })) });
    if (method === 'POST') return send(res, 201, await create(req));
  }
  const match = /^\/api\/agreements\/([a-f0-9-]+)\/(hash|audit|signed|invite|accept)$/.exec(pathname);
  if (match) {
    sender(req, res);
    const row = get(match[1]);
    if (!row || row.owner !== owner) fail(404, 'Agreement not found');
    const action = match[2];
    if (method === 'GET' && action === 'hash') return send(res, 200, { algorithm: 'SHA-256', hash: digest(pdf(row, 'original')) });
    if (method === 'GET' && action === 'audit') return send(res, 200, { agreement: publicInfo(row), testSignerPublicKey: detail(row).signatureMode === 'mock' ? mock?.publicKey : undefined, events: auditEntries(row.id) },
      { 'Content-Disposition': 'attachment; filename="agreement-audit.json"' });
    if (method === 'GET' && action === 'signed') return send(res, 200, pdf(row, 'final'),
      { ...pdfHeaders, 'Content-Disposition': 'attachment; filename="' + (detail(row).signatureMode === 'mock' ? 'sandbox-evidence.pdf' : 'signed-agreement.pdf') + '"' });
    if (method === 'POST' && action === 'accept') {
      await json(req, 4096);
      const accepted = transaction(() => {
        const current = get(row.id);
        const info = detail(current);
        if (current.status !== 'Signed') fail(409, 'Only signed agreements can be accepted');
        if (!info.email) fail(409, 'This recipient has no email address');
        if (!info.acceptedAt) {
          info.acceptedAt = new Date().toISOString();
          run('UPDATE agreements SET details=? WHERE id=?', pack(info, row.id + ':details'), row.id);
          audit(req, row.id, 'sender_accepted');
        }
        return info;
      });
      if (accepted.acceptanceEmailAt) return send(res, 200, { emailStatus: 'Gateway accepted' });
      if (!zohoMail && !env.INVITE_WEBHOOK) return send(res, 200, { emailStatus: 'Accepted. Email delivery is unconfigured.' });
      if (pendingAcceptanceEmails.has(row.id)) fail(409, 'An acceptance email is already being sent');
      pendingAcceptanceEmails.add(row.id);
      try {
        const attachment = pdf(get(row.id), 'final');
        const filename = accepted.signatureMode === 'mock' ? 'sandbox-agreement.pdf' : 'signed-agreement.pdf';
        const subject = 'Agreement accepted: ' + accepted.title;
        const message = 'The sender accepted your agreement.' + (accepted.settlementOption ? ' Selected settlement option: ' + accepted.settlementOption + '.' : '') + ' The PDF is attached.';
        if (zohoMail) {
          try {
            await zohoMail.send({ to: accepted.email, subject, text: message, copySender: true,
              attachments: [{ filename, contentType: 'application/pdf', content: attachment }],
              messageId: '<' + row.id + '.acceptance@' + zohoMail.address.split('@').at(-1) + '>' });
          } catch {
            fail(502, 'Acceptance saved. Zoho Mail could not send the PDF. Check SMTP settings and retry.');
          }
        } else {
          const url = new URL(env.INVITE_WEBHOOK);
          if (url.protocol !== 'https:' || !env.INVITE_WEBHOOK_TOKEN) fail(503, 'Email gateway needs HTTPS and a token');
          const delivery = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.INVITE_WEBHOOK_TOKEN,
              'Idempotency-Key': row.id + ':sender-acceptance' },
            body: JSON.stringify({ channel: 'email', destination: accepted.email, subject, message,
              attachments: [{ filename, contentType: 'application/pdf', contentBase64: attachment.toString('base64') }] }) });
          if (!delivery.ok) fail(502, 'Acceptance saved. The email gateway rejected delivery. Retry from the dashboard.');
        }
        transaction(() => {
          const info = detail(get(row.id));
          if (info.acceptanceEmailAt) return;
          info.acceptanceEmailAt = new Date().toISOString();
          run('UPDATE agreements SET details=? WHERE id=?', pack(info, row.id + ':details'), row.id);
          audit(req, row.id, 'acceptance_email_gateway_accepted', { provider: zohoMail ? 'zoho' : 'webhook' });
        });
        return send(res, 200, { emailStatus: zohoMail ? 'Zoho Mail accepted the email' : 'Gateway accepted' });
      } finally {
        pendingAcceptanceEmails.delete(row.id);
      }
    }
    if (method === 'POST' && action === 'invite') {
      if (['Expired', 'Signed', 'Declined'].includes(publicInfo(row).status)) fail(409, 'Link is closed');
      const { channel } = await json(req, 4096);
      const info = detail(row);
      const destination = channel === 'email' ? info.email : channel === 'sms' ? info.phone : '';
      if (!destination) fail(400, 'Invalid invitation channel or missing destination');
      const message = info.sender + ' invited you to review and sign ' + info.title + '. ' + link(row);
      if (channel === 'email' && zohoMail) {
        if (['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) {
          fail(409, 'Set a recipient-accessible PUBLIC_ORIGIN before emailing signing links');
        }
        try { await zohoMail.send({ to: destination, subject: 'Agreement for signature', text: message }); }
        catch { fail(502, 'Zoho Mail could not send the invitation. Check SMTP settings.'); }
        transaction(() => audit(req, row.id, 'invite_gateway_accepted', { channel, provider: 'zoho' }));
        return send(res, 200, { deliveredToGateway: true });
      }
      if (env.INVITE_WEBHOOK) {
        const url = new URL(env.INVITE_WEBHOOK);
        if (url.protocol !== 'https:' || !env.INVITE_WEBHOOK_TOKEN) fail(503, 'Invitation gateway needs HTTPS and a token');
        const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.INVITE_WEBHOOK_TOKEN },
          body: JSON.stringify({ channel, destination, subject: 'Agreement for signature', message }) });
        if (!response.ok) fail(502, 'Invitation gateway rejected the request');
        transaction(() => audit(req, row.id, 'invite_gateway_accepted', { channel }));
        return send(res, 200, { deliveredToGateway: true });
      }
      transaction(() => audit(req, row.id, 'invite_draft_requested', { channel }));
      const url = channel === 'email'
        ? 'mailto:' + encodeURIComponent(destination) + '?subject=Agreement%20for%20signature&body=' + encodeURIComponent(message)
        : 'sms:' + encodeURIComponent(destination) + '?body=' + encodeURIComponent(message);
      return send(res, 200, { url });
    }
  }
  if (pathname.startsWith('/api/review/')) {
    const row = recipient(req);
    if (method === 'GET' && pathname === '/api/review/details') {
      const info = detail(row);
      const sha256 = digest(pdf(row, 'original'));
      return send(res, 200, { title: info.title, name: info.name, sender: info.sender, created: info.created, status: row.status,
        expires: row.expires, integrityVerified: true, sha256, consentText, mode, decisions, settlementOptions, settlementOption: info.settlementOption, declinedAt: info.declinedAt, debtor: info.debtor });
    }
    if (method === 'GET' && pathname === '/api/review/pdf') {
      const original = pdf(row, 'original');
      transaction(() => {
        if (run("UPDATE agreements SET status='Viewed' WHERE id=? AND status='Sent'", row.id).changes) audit(req, row.id, 'document_viewed');
      });
      return send(res, 200, original, pdfHeaders);
    }
    if (method === 'POST' && pathname === '/api/review/decline') {
      const input = await json(req, 4096);
      if (input.decision !== decisions[1] || input.reviewed !== true) fail(400, 'Confirm review and select Decline agreement');
      transaction(() => {
        const current = get(row.id);
        const info = detail(current);
        if (status(current) !== 'Viewed') fail(409, 'Agreement cannot be declined');
        if (info.declinedAt) return;
        info.declinedAt = new Date().toISOString();
        info.decision = input.decision;
        run('UPDATE agreements SET details=? WHERE id=?', pack(info, row.id + ':details'), row.id);
        audit(req, row.id, 'recipient_declined', { decision: input.decision, consent: false });
      });
      return send(res, 200, { status: 'Declined' });
    }
    if (method === 'POST' && pathname === '/api/review/start') return send(res, 201, await initiate(req, row));
    if (method === 'POST' && pathname === '/api/review/simulate') return send(res, 200, await simulate(req, row));
  }
  fail(404, 'Page not found');
}
const handle = (req, res) => route(req, res).catch(error => {
  const code = Number.isInteger(error.code) ? error.code : 500;
  if (code === 500) console.error('Request failed:', error.name, error.code ?? '');
  if (!res.headersSent) send(res, code, { error: code === 500 ? 'The request could not be completed' : error.message });
  else res.end();
});
const app = tls ? https({ key: readFileSync(env.TLS_KEY), cert: readFileSync(env.TLS_CERT), minVersion: 'TLSv1.2' }, handle) : http(handle);
app.requestTimeout = 30000;
app.listen(port, host, () => {
  if (!port && !env.PUBLIC_ORIGIN) origin = new URL(origin).protocol + '//127.0.0.1:' + app.address().port;
  console.log('Accord ' + mode + ' is available at ' + origin);
  if (mode === 'mock') console.log('Sandbox sender credentials: ' + owner + ' / ' + password);
});








