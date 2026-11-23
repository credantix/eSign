export const templates = {
  services: 'The parties agree that the service provider will perform the scope described below. Scope, fees and due dates are subject to the terms entered by the sender. Each party will designate a point of contact for performance and notices.',
  confidentiality: 'Each party will protect confidential information received for the stated purpose and use it only for that purpose. Information already public, independently developed, or lawfully received without restriction is excluded.',
};
export function templatePdf(title, sender, recipient, template, terms) {
  function printable(value) {
    return value.normalize('NFKD').replace(/[^\x20-\x7e\n]/g, '?');
  }
  const content = [title, '', 'Sender: ' + sender, 'Recipient: ' + recipient, '', templates[template], '', terms];
  const lines = content.flatMap(value => printable(value).split('\n').flatMap(line => line.match(/.{1,78}/g) ?? ['']));
  const pages = [];
  for (let i = 0; i < lines.length; i += 44) pages.push(lines.slice(i, i + 44));
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [' + pages.map((_, i) => (4 + i * 2) + ' 0 R').join(' ') + '] /Count ' + pages.length + ' >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [i, page] of pages.entries()) {
    const stream = 'BT /F1 12 Tf 54 770 Td 16 TL ' + page.map(line => '(' + line.replace(/[()\\]/g, '\\$&') + ') Tj T*').join('\n') + ' ET';
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + (5 + i * 2) + ' 0 R >>',
      '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
  }
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = pdf.length;
    pdf += (i + 1) + ' 0 obj\n' + object + '\nendobj\n';
    return offset;
  });
  const start = pdf.length;
  pdf += 'xref\n0 ' + (offsets.length + 1) + '\n0000000000 65535 f \n' +
    offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + (offsets.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + start + '\n%%EOF\n';
  return Buffer.from(pdf);
}
