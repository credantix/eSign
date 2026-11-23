export async function configureZohoMail(env) {
  const { ZOHO_SMTP_HOST: host, ZOHO_SMTP_USER: user = 'admin@credantix.com', ZOHO_SMTP_PASSWORD: pass } = env;
  if (!host && !env.ZOHO_SMTP_USER && !pass) return null;
  if (!host || !user || !pass) throw Error('Set ZOHO_SMTP_HOST, ZOHO_SMTP_USER and ZOHO_SMTP_PASSWORD together');
  const port = Number(env.ZOHO_SMTP_PORT ?? 465);
  if (!/^(?:smtp|smtppro)\.zoho\.[a-z.]+$/i.test(host) || ![465, 587].includes(port)) {
    throw Error('Use the Zoho SMTP hostname shown in Mail settings and port 465 or 587');
  }
  const { default: nodemailer } = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    host, port, secure: port === 465, requireTLS: port === 587,
    auth: { user, pass }, tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return {
    address: user,
    verify: () => transporter.verify(),
    async send({ to, subject, text, attachments, messageId, copySender = false }) {
      const result = await transporter.sendMail({
        from: { address: user, name: env.SENDER_NAME ?? 'Agreement Workspace' },
        to: { address: to, name: '' }, cc: copySender && to.toLowerCase() !== user.toLowerCase() ? { address: user, name: '' } : undefined,
        subject, text, attachments, messageId,
      });
      if (!result.accepted.some(address => address.toLowerCase() === to.toLowerCase())) throw Error('Zoho SMTP did not accept the recipient');
    },
  };
}

