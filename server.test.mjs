import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, verify } from 'node:crypto';

test('agreement lifecycle, callback integrity and scope', { timeout: 20000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'accord-test-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, PORT: '0', PUBLIC_ORIGIN: '', ESIGN_MODE: 'mock', DATA_DIR: folder,
      SENDER_USER: 'sender', SENDER_PASSWORD: 'test-password', TLS_KEY: '', TLS_CERT: '', INVITE_WEBHOOK: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    let output = '';
    const origin = await new Promise((resolve, reject) => {
      child.on('exit', code => reject(Error('Server exited with ' + code)));
      child.on('error', reject);
      child.stdout.on('data', part => {
        output += part.toString();
        const match = /available at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) resolve(match[1]);
      });
    });
    const sender = 'Basic ' + Buffer.from('sender:test-password').toString('base64');
    const call = (url, authorization, body) => fetch(origin + url, {
      method: body ? 'POST' : 'GET',
      headers: { ...(authorization ? { authorization } : {}),
        ...(body ? { 'content-type': 'application/json', 'x-accord-request': '1' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal((await call('/')).status, 401);
    assert.equal((await call('/', sender)).status, 200);
    const created = await call('/api/agreements', sender, { title: 'Services (Pilot)', name: 'Test Recipient', email: 'test@example.test',
      template: 'services', terms: 'Deliver a prototype (and a report).', matchName: true });
    assert.equal(created.status, 201);
    const agreement = await created.json();
    const endpoint = '/api/agreements/' + agreement.id;
    const bearer = 'Bearer ' + new URL(agreement.link).hash.slice(1);
    assert.equal((await call(endpoint + '/audit', bearer)).status, 401);
    assert.equal((await call('/api/review/details', bearer + 'x')).status, 401);
    assert.equal((await (await call('/api/review/details', bearer)).json()).integrityVerified, true);
    const original = Buffer.from(await (await call('/api/review/pdf', bearer)).arrayBuffer());
    const originalHash = createHash('sha256').update(original).digest('hex');
    assert.equal(originalHash, (await (await call(endpoint + '/hash', sender)).json()).hash);
    const upload = await call('/api/agreements', sender, { title: 'Uploaded PDF', name: 'Test Recipient', phone: '+911234567890',
      pdf: original.toString('base64') });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    assert.equal(uploaded.sha256, originalHash);
    const uploadBearer = 'Bearer ' + new URL(uploaded.link).hash.slice(1);
    assert.equal((await call('/api/review/pdf', uploadBearer)).status, 200);
    assert.equal((await call('/api/review/decline', uploadBearer, { reviewed: true, decision: 'Decline agreement' })).status, 200);
    assert.equal((await call('/api/review/start', uploadBearer, { reviewed: true, consent: true, decision: 'Accept agreement' })).status, 409);
    assert.equal((await (await call(endpoint + '/invite', sender, { channel: 'email' })).json()).url.startsWith('mailto:'), true);
    assert.equal((await call('/api/review/start', bearer, { reviewed: false, consent: true })).status, 400);
    const attempt = await (await call('/api/review/start', bearer, { reviewed: true, consent: true, decision: 'Accept agreement' })).json();
    assert.equal((await call('/api/esign/callback', null, { message: 'abc', signature: 'def' })).status, 403);
    const simulate = signerName => call('/api/review/simulate', bearer, { attemptId: attempt.attemptId, signerName });
    assert.equal((await (await simulate('Wrong Name')).json()).status, 'Rejected');
    assert.equal((await (await simulate('test recipient')).json()).status, 'Signed');
    assert.equal((await simulate('test recipient')).status, 409);
    const final = Buffer.from(await (await call(endpoint + '/signed', sender)).arrayBuffer());
    assert.deepEqual(final.subarray(0, original.length), original);
    const audit = await (await call(endpoint + '/audit', sender)).json();
    assert.deepEqual(audit.events.map(event => event.type),
      ['link_created', 'document_viewed', 'invite_draft_requested', 'consent_received', 'signer_mismatch', 'signed']);
    assert.equal(audit.agreement.debtor.name, 'test recipient');
    assert.equal(audit.agreement.decision, 'Accept agreement');
    assert.equal((await call(endpoint + '/accept', bearer, {})).status, 401);
    assert.equal((await call(endpoint + '/accept', sender, {})).status, 200);
    assert.equal((await call(endpoint + '/accept', sender, {})).status, 200);
    const accepted = await (await call(endpoint + '/audit', sender)).json();
    assert.ok(accepted.agreement.acceptedAt);
    assert.equal(accepted.events.filter(event => event.type === 'sender_accepted').length, 1);
    assert.equal(audit.agreement.finalSha256, createHash('sha256').update(final).digest('hex'));
    const [message, signature] = final.subarray(original.length).toString().trim().split(' ').slice(-2).map(value => Buffer.from(value, 'base64url'));
    assert.ok(verify(null, message, audit.testSignerPublicKey, signature));
    assert.equal(JSON.parse(message).signingDigest, originalHash);
    assert.equal((await call('/api/esign/callback', null, { message: message.toString('base64url'), signature: signature.toString('base64url') })).status, 200);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(folder, { recursive: true, force: true });
  }
});


