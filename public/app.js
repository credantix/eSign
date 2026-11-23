const main = document.querySelector('#main');
const mode = document.querySelector('#mode');
const toast = document.querySelector('#toast');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
})[char]);
const date = value => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
let toastTimer;
function notify(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}
function setMode(value) {
  mode.textContent = value === 'mock' ? 'Sandbox mode' : 'Live eSign';
  mode.hidden = false;
}
async function request(path, { token, body, blob = false } = {}) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  if (body) Object.assign(headers, { 'Content-Type': 'application/json', 'X-Accord-Request': '1' });
  const response = await fetch(path, { headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw Error((await response.json()).error);
  return blob ? response.blob() : response.json();
}
function errorPage(error) {
  main.innerHTML = '<section class="panel"><h1>Agreement unavailable</h1><p class="muted">' + escapeHtml(error.message) + '</p></section>';
}
function encodeFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(Error('Could not read the PDF'));
    reader.readAsDataURL(file);
  });
}
function button(label, attrs) { return '<button type="button" ' + attrs + '>' + label + '</button>'; }

async function dashboard() {
  main.innerHTML = `
    <section class="intro"><div><h1>Agreements</h1><p>Send agreements for signature and track their progress.</p></div>
    <button class="primary" id="new">New agreement</button></section>
    <section class="stats" id="stats" aria-label="Agreement counts"></section>
    <section class="panel"><div class="toolbar"><h2>All agreements</h2><div class="actions">
    <input id="search" type="search" placeholder="Search agreements" aria-label="Search agreements"><button id="refresh">Refresh</button></div></div>
    <div id="records" class="scroll" aria-live="polite"></div></section>
    <dialog id="create"><h2>New agreement</h2><form id="create-form">
      <label>Agreement title<input name="title" required maxlength="160"></label>
      <label>Document source<select id="source"><option value="template">Create from template</option><option value="upload">Upload a PDF</option></select></label>
      <div id="template-fields"><label>Template<select name="template"><option value="services">Services agreement</option><option value="confidentiality">Confidentiality agreement</option></select></label>
      <label>Agreement terms<textarea name="terms" maxlength="20000" placeholder="Enter the terms the recipient should review"></textarea></label></div>
      <label id="upload-field" hidden>Agreement PDF<input name="file" type="file" accept="application/pdf,.pdf"></label>
      <label>Recipient name<input name="name" required maxlength="120"></label>
      <div class="pair"><label>Email<input name="email" type="email" maxlength="254"></label>
      <label>Phone<input name="phone" type="tel" placeholder="+91…" maxlength="24"></label></div>
      <label>Link lifetime in hours<input name="hours" type="number" min="1" max="72" required value="24"></label>
      <label class="check"><input name="matchName" type="checkbox">Require signer name to match recipient name</label>
      <p class="error" role="alert"></p><div class="actions"><button class="primary">Create signing link</button><button type="button" id="cancel">Cancel</button></div>
    </form></dialog>
    <dialog id="share"><h2>Share signing link</h2><form method="dialog"><label>Recipient link<input id="link" readonly></label>
    <div class="actions"><button type="button" id="copy">Copy link</button><a class="button" id="open-link" target="_blank" rel="noopener noreferrer">Open review</a>
    <button type="button" id="email">Email invite</button><button type="button" id="sms">SMS invite</button><button>Done</button></div></form></dialog>`;
  const byId = id => document.getElementById(id);
  const createDialog = byId('create'), shareDialog = byId('share');
  const form = byId('create-form'), source = byId('source');
  const search = byId('search'), records = byId('records');
  let items = [], selected;
  function render() {
    const states = ['Sent', 'Viewed', 'Signed', 'Declined', 'Expired'];
    byId('stats').innerHTML = states.map(state => '<div class="stat"><span>' + state + '</span><strong>' +
      items.filter(item => item.status === state).length + '</strong></div>').join('');
    const filtered = items.filter(item => (item.title + ' ' + item.name).toLowerCase().includes(search.value.trim().toLowerCase()));
    records.innerHTML = filtered.length ? `<table><thead><tr><th>Agreement</th><th>Recipient</th><th>Status</th><th>Link expires</th><th>Actions</th></tr></thead><tbody>` +
      filtered.map(item => {
        const endpoint = '/api/agreements/' + item.id;
        return '<tr><td><strong>' + escapeHtml(item.title) + '</strong></td><td>' + escapeHtml(item.debtor?.name ?? item.name) +
          '<small>' + escapeHtml(item.email || item.phone) + '</small>' + (item.settlementOption ? '<small>Settlement: ' + escapeHtml(item.settlementOption) + '</small>' : '') + '</td><td><span class="tag ' + item.status + '">' + item.status +
          '</span>' + (item.acceptedAt ? '<small>' + (item.acceptanceEmailAt ? 'Accepted · Email queued' : 'Accepted · Email pending') + '</small>' : '') + '</td><td>' + escapeHtml(date(item.expires)) + '</td><td><div class="actions">' +
          (item.link ? button('Share', 'data-id="' + item.id + '"') : '') +
          (item.status === 'Signed' ? '<a class="button" href="' + endpoint + '/signed">' + (item.signatureMode === 'mock' ? 'Sandbox PDF' : 'Signed PDF') + '</a>' : '') +
          (item.status === 'Signed' && !item.acceptanceEmailAt ? button(item.acceptedAt ? 'Retry email' : 'Accept & email', 'data-accept="' + item.id + '"') : '') +
          '<a class="button" href="' + endpoint + '/audit">Audit trail</a></div></td></tr>';
      }).join('') + '</tbody></table>' : '<div class="empty">' + (items.length ? 'No agreements match your search.' : 'Create an agreement to get started.') + '</div>';
  }
  async function load() {
    const result = await request('/api/agreements');
    items = result.agreements;
    setMode(result.mode);
    render();
  }
  function share(item) {
    selected = item;
    byId('link').value = item.link;
    byId('open-link').href = item.link;
    byId('email').hidden = !item.email;
    byId('sms').hidden = !item.phone;
    shareDialog.showModal();
  }
  records.addEventListener('click', async event => {
    const approval = event.target.closest('[data-accept]');
    if (approval) {
      if (!window.confirm('Accept this signed agreement and email the PDF to the recipient?')) return;
      approval.disabled = true;
      try {
        const result = await request('/api/agreements/' + approval.dataset.accept + '/accept', { body: {} });
        notify(result.emailStatus);
      } catch (error) { notify(error.message); }
      finally {
        approval.disabled = false;
        load().catch(() => {});
      }
      return;
    }
    const id = event.target.closest('button')?.dataset.id;
    if (id) share(items.find(item => item.id === id));
  });
  byId('new').onclick = () => createDialog.showModal();
  byId('cancel').onclick = () => createDialog.close();
  byId('refresh').onclick = () => load().catch(error => notify(error.message));
  search.oninput = render;
  source.onchange = () => {
    byId('upload-field').hidden = source.value !== 'upload';
    byId('template-fields').hidden = source.value === 'upload';
  };
  form.onsubmit = async event => {
    event.preventDefault();
    const submit = form.querySelector('.primary');
    const errorMessage = form.querySelector('.error');
    submit.disabled = true;
    errorMessage.textContent = '';
    try {
      const data = new FormData(form);
      const payload = Object.fromEntries(data);
      delete payload.file;
      payload.matchName = data.has('matchName');
      if (source.value === 'upload') {
        const file = data.get('file');
        if (!file.size || file.size > 10_000_000) throw Error('Choose a PDF up to 10 MB');
        payload.pdf = await encodeFile(file);
      }
      const item = await request('/api/agreements', { body: payload });
      items.unshift(item);
      render();
      createDialog.close();
      form.reset();
      source.onchange();
      share(item);
    } catch (error) { errorMessage.textContent = error.message; }
    finally { submit.disabled = false; }
  };
  byId('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(selected.link); notify('Signing link copied'); }
    catch { byId('link').select(); notify('Copy the selected signing link'); }
  };
  for (const channel of ['email', 'sms']) {
    byId(channel).onclick = async event => {
      const target = event.currentTarget;
      target.disabled = true;
      try {
        const result = await request('/api/agreements/' + selected.id + '/invite', { body: { channel } });
        if (result.url) location.href = result.url;
        else notify('Invitation accepted by delivery gateway');
      } catch (error) { notify(error.message); }
      finally { target.disabled = false; }
    };
  }
  await load();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load().catch(() => {});
  });
}

async function review() {
  const token = location.hash.slice(1) || sessionStorage.getItem('accord-review');
  if (!token) throw Error('Open the signing link sent by the agreement sender.');
  if (location.hash) {
    sessionStorage.setItem('accord-review', token);
    history.replaceState(null, '', '/review');
  }
  const info = await request('/api/review/details', { token });
  setMode(info.mode);
  const original = await request('/api/review/pdf', { token, blob: true });
  const pdfUrl = URL.createObjectURL(original);
  window.addEventListener('pagehide', () => URL.revokeObjectURL(pdfUrl), { once: true });
  main.innerHTML = `<section class="intro"><div><h1>${escapeHtml(info.title)}</h1><p>Agreement shared by ${escapeHtml(info.sender)}</p></div></section>
    <div class="review"><section class="panel viewer"><iframe title="Agreement PDF" src="${pdfUrl}"></iframe>
    <a class="button" href="${pdfUrl}" target="_blank" rel="noopener noreferrer">Open PDF separately</a></section>
    <section class="panel"><h2>Review agreement</h2><p class="ok">Document integrity verified</p>
    <dl><dt>Recipient</dt><dd>${escapeHtml(info.debtor?.name ?? info.name)}</dd><dt>Created</dt><dd>${escapeHtml(date(info.created))}</dd>
    <dt>Link expires</dt><dd>${escapeHtml(date(info.expires))}</dd><dt>SHA-256</dt><dd><code>${escapeHtml(info.sha256)}</code></dd></dl>
    <div id="signing"></div></section></div>`;
  const panel = document.querySelector('#signing');
  if (info.declinedAt) {
    panel.textContent = 'You declined this agreement.';
    return;
  }
  if (info.status === 'Signed') {
    panel.textContent = (info.mode === 'mock' ? 'Sandbox signing completed.' : 'This agreement has been signed.') + (info.settlementOption ? ' Selected settlement: ' + info.settlementOption + '.' : '');
    return;
  }
  panel.innerHTML = `<form id="consent"><label>Settlement option<select name="settlementOption" required><option value="">Select an option</option>${info.settlementOptions.map(option => '<option>' + escapeHtml(option) + '</option>').join('')}</select></label><label>Your decision<select name="decision" required><option value="">Select an option</option>${info.decisions.map(option => '<option>' + escapeHtml(option) + '</option>').join('')}</select></label><label class="check"><input type="checkbox" required name="reviewed">I scrolled through and read the full agreement.</label>
    <label class="check"><input type="checkbox" required name="consent">${escapeHtml(info.consentText)}</label>
    <p class="error" role="alert"></p><button class="primary">${info.mode === 'mock' ? 'Continue to sandbox eSign' : 'Continue to Aadhaar eSign'}</button></form>
    <dialog id="sandbox"><h2>Sandbox eSign</h2><p>Simulate provider approval using a test signer name.</p><form id="mock">
    <label>Test signer name<input name="name" maxlength="120" required></label><p class="error" role="alert"></p>
    <div class="actions"><button class="primary">Approve test signature</button><button type="button" id="back">Cancel</button></div></form></dialog>`;
  const consent = panel.querySelector('#consent'), dialog = panel.querySelector('#sandbox');
  const simulate = panel.querySelector('#mock');
  let attempt;
  const decision = consent.elements.decision;
  const signatureConsent = consent.elements.consent;
  const settlementOption = consent.elements.settlementOption;
  decision.onchange = () => {
    const declining = decision.value === 'Decline agreement';
    signatureConsent.required = !declining;
    settlementOption.required = !declining;
    settlementOption.disabled = declining;
    signatureConsent.closest('label').hidden = declining;
    consent.querySelector('button').textContent = declining ? 'Submit decision' :
      (info.mode === 'mock' ? 'Continue to sandbox eSign' : 'Continue to Aadhaar eSign');
  };
  consent.onsubmit = async event => {
    event.preventDefault();
    const button = consent.querySelector('button');
    consent.querySelector('.error').textContent = '';
    button.disabled = true;
    try {
      if (decision.value === 'Decline agreement') {
        await request('/api/review/decline', { token, body: { decision: decision.value, reviewed: consent.elements.reviewed.checked } });
        panel.textContent = 'You declined this agreement.';
        return;
      }
      attempt = await request('/api/review/start', { token, body: {
        decision: decision.value, settlementOption: settlementOption.value,
        reviewed: consent.elements.reviewed.checked, consent: consent.elements.consent.checked,
      } });
      if (attempt.redirectUrl) location.assign(attempt.redirectUrl);
      else {
        simulate.elements.name.value = info.name;
        simulate.querySelector('.error').textContent = '';
        dialog.showModal();
      }
    } catch (error) { consent.querySelector('.error').textContent = error.message; }
    finally { button.disabled = false; }
  };
  panel.querySelector('#back').onclick = () => dialog.close();
  simulate.onsubmit = async event => {
    event.preventDefault();
    const button = simulate.querySelector('.primary');
    button.disabled = true;
    try {
      const result = await request('/api/review/simulate', { token, body: { attemptId: attempt.attemptId, signerName: simulate.elements.name.value } });
      if (result.status !== 'Signed') throw Error(result.reason ?? 'Signature rejected');
      dialog.close();
      panel.textContent = 'Sandbox signing completed. Selected settlement: ' + settlementOption.value + '.';
      sessionStorage.removeItem('accord-review');
    } catch (error) { simulate.querySelector('.error').textContent = error.message; }
    finally { button.disabled = false; }
  };
}

(location.pathname === '/' ? dashboard() : review()).catch(errorPage);



