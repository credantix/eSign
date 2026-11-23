import { configureZohoMail } from './zoho-mail.mjs';
try {
  const mail = await configureZohoMail(process.env);
  if (!mail) throw Error('missing configuration');
  await mail.verify();
  console.log('Zoho SMTP connection and authentication succeeded. No email was sent.');
} catch (error) {
  console.error('Zoho SMTP verification failed. Check host, port and app password.', error.code ?? '');
  process.exitCode = 1;
}
