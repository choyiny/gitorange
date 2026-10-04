import { appName } from './app-name';

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Whether outbound email (the `EMAIL` Email Sending binding and `FROM_EMAIL`) is set up. */
export function emailConfigured(
  env: Pick<CloudflareBindings, 'EMAIL' | 'FROM_EMAIL'>
): boolean {
  return Boolean(env.EMAIL && env.FROM_EMAIL);
}

async function send(
  env: CloudflareBindings,
  kind: string,
  m: { to: string; subject: string; text: string; html: string }
): Promise<boolean> {
  if (!emailConfigured(env)) return false;
  try {
    await env.EMAIL.send({
      from: { email: env.FROM_EMAIL, name: appName(env) },
      ...m,
    });
    return true;
  } catch (e) {
    console.error(`[${kind}] email send failed`, e);
    return false;
  }
}

const shell = (body: string) =>
  `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:544px;margin:0 auto;color:#1f2328">${body}</div>`;
const button = (url: string, label: string) =>
  `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:8px 16px;background:#1f883d;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">${label}</a></p>`;

export async function sendInviteEmail(
  env: CloudflareBindings,
  opts: { to: string; inviterName: string; url: string }
): Promise<boolean> {
  const app = appName(env);
  return send(env, 'invite', {
    to: opts.to,
    subject: `${opts.inviterName} invited you to join ${app}`,
    text: `${opts.inviterName} has invited you to join ${app}.\n\nAccept the invitation:\n${opts.url}\n\nThis invitation expires in 7 days.`,
    html: shell(`
  <h2 style="font-weight:400">@${escapeHtml(opts.inviterName)} has invited you to join <strong>${escapeHtml(app)}</strong></h2>
  ${button(opts.url, 'Accept invitation')}
  <p style="color:#59636e;font-size:12px">This invitation expires in 7 days. If you were not expecting it, you can ignore this email.</p>
`),
  });
}

/** Asks the owner of an alternate commit email to confirm it. */
export async function sendEmailVerification(
  env: CloudflareBindings,
  opts: { to: string; username: string; url: string; hours: number }
): Promise<boolean> {
  const app = appName(env);
  return send(env, 'verify-email', {
    to: opts.to,
    subject: `Verify your email for ${app}`,
    text: `@${opts.username} added ${opts.to} to their ${app} account. Commits authored with this address will be linked to their profile once it is verified.\n\nVerify this email (you must be signed in as @${opts.username}):\n${opts.url}\n\nThis link expires in ${opts.hours} hours. If you did not add this address, you can ignore this email.`,
    html: shell(`
  <h2 style="font-weight:400">Verify <strong>${escapeHtml(opts.to)}</strong> for <strong>${escapeHtml(app)}</strong></h2>
  <p>@${escapeHtml(opts.username)} added this address to their account. Commits authored with it will be linked to their profile once it is verified.</p>
  ${button(opts.url, 'Verify email')}
  <p style="color:#59636e;font-size:12px">This link expires in ${opts.hours} hours and works only while signed in as @${escapeHtml(opts.username)}. If you did not add this address, you can ignore this email.</p>
`),
  });
}
