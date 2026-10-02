function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export async function sendInviteEmail(
  env: CloudflareBindings,
  opts: { to: string; inviterName: string; url: string }
): Promise<boolean> {
  const app = env.APP_NAME || 'GitOrange';
  const subject = `${opts.inviterName} invited you to join ${app}`;
  const text = `${opts.inviterName} has invited you to join ${app}.\n\nAccept the invitation:\n${opts.url}\n\nThis invitation expires in 7 days.`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:544px;margin:0 auto;color:#1f2328">
  <h2 style="font-weight:400">@${escapeHtml(opts.inviterName)} has invited you to join <strong>${escapeHtml(app)}</strong></h2>
  <p><a href="${escapeHtml(opts.url)}" style="display:inline-block;padding:8px 16px;background:#1f883d;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">Accept invitation</a></p>
  <p style="color:#59636e;font-size:12px">This invitation expires in 7 days. If you were not expecting it, you can ignore this email.</p>
</div>`;
  try {
    await env.EMAIL.send({
      from: { email: env.FROM_EMAIL, name: app },
      to: opts.to,
      subject,
      text,
      html,
    });
    return true;
  } catch (e) {
    console.error('[invite] email send failed', e);
    return false;
  }
}
