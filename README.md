# Accord

Accord is a single-sender agreement workspace with a local signing sandbox and an ASP adapter boundary. It runs on Node.js 24 with no npm dependencies.

## Quick start

From this directory, run:

```powershell
npm start
```

Open `http://127.0.0.1:8787` and enter the sandbox sender credentials printed in the terminal. Set `SENDER_PASSWORD` before startup to keep the same password across restarts. Create an agreement, open its review link, view the PDF, confirm review and consent, then approve the test signature. Refresh the dashboard to download the sandbox PDF and JSON audit trail. Test only with synthetic names and documents. Run `npm test` for an automated API smoke test.

`ESIGN_MODE=mock` is the default and binds to loopback. Set both `TLS_KEY` and `TLS_CERT` to exercise HTTPS locally and use a corresponding HTTPS `PUBLIC_ORIGIN`. The local sandbox works over loopback HTTP without certificates. A sandbox export includes signed detached test evidence in a trailing PDF comment. It can be verified with the sandbox public key from the audit export. A PDF reader will not display that evidence as a certificate-backed PDF signature.

## Stack and layout

The development stack is browser HTML, CSS and JavaScript, a Node.js HTTP/HTTPS ASP service, SQLite, and AES-256-GCM field encryption. For production, use a managed PostgreSQL database with migrations, KMS-managed envelope encryption, private immutable object versions for PDFs and audit checkpoints, an OIDC sender identity with MFA, a queued email/SMS gateway, and the contracted ESP's approved PDF/CMS and PKI toolkit.

| File | Responsibility |
| --- | --- |
| `server.mjs` | Authorization, agreements, recipient links, review, integrity, consent, callback and downloads |
| `schema.sql` | SQLite tables and audit index |
| `pdf.mjs` | Services and confidentiality template rendering. Templates support printable ASCII. Uploads preserve original PDF bytes. |
| `mock-provider.mjs` | Local Ed25519 test signatures and response verification |
| `public/` | Sender dashboard, agreement composer, invite dialog, PDF/consent review and sandbox approval |
| `server.test.mjs` | Isolated sandbox workflow and rejection tests |

### Data model

`agreements` stores the sender owner, expiry and status, plus encrypted metadata and original/final PDF blobs. Metadata includes recipient contact, verification policy, creation time and the original/final SHA-256 hashes. Expired is calculated on access for unsigned agreements. Sent means a signing link was issued. The audit distinguishes an invite draft from a gateway acknowledgment. Viewed means the PDF endpoint served the original. The recipient's read checkbox is an attestation because the native PDF viewer does not expose reliable cross-browser scroll telemetry.

`attempts` stores the agreement reference, short expiry, unique successful provider event ID and encrypted signing digest, state and receipt. `audit` stores ordered encrypted entries with event time, peer IP, consent text/version, digest, attempt/event IDs when applicable and a predecessor hash. The chain and authenticated encryption detect edits and middle-entry removal. Use separately retained signed checkpoints or immutable storage for tail-truncation detection. Document details, PDFs, attempt evidence and audit payloads are encrypted. Record IDs, timestamps used for expiry, lifecycle status and other routing columns remain queryable in SQLite. The local key file lives next to the database for convenience. Live mode requires an externally supplied `DATA_KEY` of 32 random bytes encoded as base64.

### API

| Method and path | Authorization and behavior |
| --- | --- |
| GET /api/agreements | Sender Basic auth. List sender-owned agreements. |
| POST /api/agreements | Sender. Create from a template or a base64 PDF, record SHA-256 and return a link. |
| GET /api/agreements/:id/hash | Sender. Recompute and verify original SHA-256. |
| POST /api/agreements/:id/invite | Sender. Email/SMS delivery gateway or a draft in the default mail/SMS client. |
| GET /api/agreements/:id/signed | Sender. Reverify and download the completed PDF. |
| GET /api/agreements/:id/audit | Sender. Export JSON evidence. |
| GET /api/review/details | Recipient bearer token. Return public review metadata and verify stored bytes. |
| GET /api/review/pdf | Recipient. Serve immutable original and record first view. |
| POST /api/review/start | Recipient. Require read and consent flags, bind to original digest, create attempt and prepare provider handoff. |
| POST /api/review/simulate | Recipient. Sandbox only. Generate signed test response and dispatch it to the callback handler. |
| POST /api/esign/callback | Provider. Authenticate signed evidence, enforce transaction/digest/name checks and finalize atomically. |

Application POSTs use JSON and the custom header `X-Accord-Request: 1`. Recipient links carry an HMAC-authenticated token in the URL fragment. The UI sends the token in an Authorization header after stripping it from the address bar. A link proves possession and is shareable by whoever receives it. Sender downloads are owner-scoped. The starter models one configured sender and scoped recipient access. Use per-user accounts and organization ownership for multi-sender deployments.

Optional invitation configuration uses `INVITE_WEBHOOK` and `INVITE_WEBHOOK_TOKEN`. The application posts `{channel,destination,subject,message}` over HTTPS with bearer auth. The gateway implements the contracted email/SMS provider, delivery receipts, retries and deduplication. For recipient delivery use a reachable HTTPS origin in live deployments.

## Connect a live ESP

The live adapter is a site-specific module supplied through `ESP_ADAPTER`. Start live mode with `ESIGN_MODE=live`, `TLS_KEY`, `TLS_CERT`, `PUBLIC_ORIGIN`, `DATA_KEY` and `SENDER_PASSWORD` of at least 20 characters. Use a separate database and separate secrets for each mode. Optional configuration includes `DATA_DIR`, `PORT`, `HOST`, `SENDER_USER` and `SENDER_NAME`.

The adapter exports a default object with two async methods:

- `start({attemptId, expires, original, documentSha256, callbackUrl, returnUrl})` prepares the PDF signing revision and returns `{redirectUrl, signingDigest, state}`. Use an ESP that provides an HTTPS hosted handoff or implement a trusted redirect bridge as required by its approved protocol. Allowlist the ESP origin in the adapter. Use the contracted ASP identifier and ASP key to sign the request as required. The display hash identifies the original reviewed PDF. For a detached PDF signature, hash the prepared PDF ByteRange for signing. Preserve the exact prepared bytes in encrypted state or an immutable private reference.
- `verify({raw, headers, lookup})` handles the actual on-wire response, including any required form or XML parsing and transport authentication. Validate the signed response with pinned ESP trust, prevent XML external entities and signature wrapping, and authenticate the transaction before trusting its identifiers. Use `lookup(attemptId)` to recover verified original bytes and saved signing state. Validate the signer CMS signature and signed attributes, match the digest and PDF revision, and validate the licensed CA chain to approved Indian trust anchors under the applicable policy, including revocation and trusted time evidence. Reject unauthorized incremental PDF revisions. Extract the signer name from the verified certificate. Return `{attemptId,eventId,signingDigest,signerName,signedPdf,receipt}` only after these checks pass. Use a stable authenticated event ID and sanitize retained evidence. Return null for unverifiable results. If the ESP posts through the recipient browser, the adapter needs to handle its acknowledgment/return requirements alongside the server-to-server verification boundary.

The ESP or its authorized authentication path hosts Aadhaar/VID entry, consent and the supported OTP or biometric flow. The app has no input for Aadhaar, VID, OTP or biometrics. Keep these out of receipts, logs and provider state. App consent and provider authentication consent are distinct records. Optional name matching compares case, Unicode normalization and whitespace and rejects mismatches. Additional verified certificate fields can be added through the adapter only where the certificate, provider terms and applicable rules allow them.

The callback commits the final bytes, artifact hash, event receipt and audit entry in one transaction. A verified replay of the accepted event is idempotent. The example limits signup to a single configured sender. Before live use, implement provider-specific failure/return handling, monitoring and retry behavior, sender identity hardening and rate limiting, storage backups and retention/deletion controls, and verify uploaded PDFs with a hardened parser and isolated preview. Complete ASP enrollment, contractual and security reviews, pre-production certification and independent signed-PDF verification with the selected ESP.

The sandbox is runnable today. Live eSign requires the contracted ESP adapter and credentials, and this starter does not establish regulatory compliance or determine whether a specific agreement is eligible. Review document eligibility, applicable stamping and registration requirements with Indian counsel.

- [CCA eSign overview](https://cca.gov.in/eSign.html)
- [CCA eSign API specifications](https://cca.gov.in/eSignAPI.html)
- [CCA eSign and ASP FAQ](https://cca.gov.in/eSign_service_faq.html)
- [UIDAI authentication and offline verification regulations](https://uidai.gov.in/images/The_Aadhaar_Authentication_and_Offline_Verifications_Regulations_2021-_Clean_copy-30122025.pdf)
- [India Code Information Technology Act](https://www.indiacode.nic.in/indiacode/handle/123456789/1999?locale=en)

## Recipient decision and sender acceptance

Recipients select Accept agreement or Decline agreement after review. Decline closes the signing workflow. Accepting proceeds through eSign. After a valid callback the sender dashboard and audit export show the debtor name supplied by the verified signing certificate, or the test name in sandbox mode. The original PDF is preserved. To print verified debtor details inside a live PDF, the ESP must provide an approved identity-verification step before PDF preparation. Populate the approved fields, show the exact revised PDF to the recipient for review and consent, and then prepare and sign that revision. A callback cannot safely insert visible text into a PDF that was already signed. Aadhaar demographics are outside this application flow.

The authenticated sender selects **Accept & email** on a signed agreement. The application records acceptance once and sends the PDF to the invitation email address through the configured HTTPS gateway. Agreements need a recipient email address for this step. Without a gateway, acceptance is saved and the dashboard shows email pending.

- `POST /api/review/decline` requires the recipient bearer token, `reviewed: true` and the decision `Decline agreement`.
- `POST /api/review/start` requires the decision `Accept agreement` along with review and signature consent.
- `POST /api/agreements/:id/accept` requires sender authentication and a JSON body of `{}`. The configured gateway receives an email request with `attachments: [{filename, contentType, contentBase64}]` and an `Idempotency-Key` header. The gateway must deduplicate on that key. Its acknowledgment is recorded separately from acceptance and does not prove inbox delivery.

Recipients must choose **Option 1**, **Option 2**, or **Option 3** before accepting and proceeding to eSign. The selection is recorded with consent and appears on the sender dashboard, audit export, and sender acceptance email. The labels refer to terms in the agreement. To include the election in the bytes covered by a live PDF signature, prepare a PDF showing the selected option and obtain review and consent for that exact PDF before invoking eSign.
