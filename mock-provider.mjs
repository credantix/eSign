import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

// Deterministic local key from a purpose-specific secret. Never used for live eSign.
export function mockProvider(secret) {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'), secret]);
  const key = createPrivateKey({ key: pkcs8, type: 'pkcs8', format: 'der' });
  const publicKey = createPublicKey(key);
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    respond(payload) {
      const message = Buffer.from(JSON.stringify(payload));
      return { message: message.toString('base64url'), signature: sign(null, message, key).toString('base64url') };
    },
    verify(response) {
      const message = Buffer.from(response.message, 'base64url');
      if (!verify(null, message, publicKey, Buffer.from(response.signature, 'base64url'))) return null;
      return JSON.parse(message.toString());
    },
  };
}
