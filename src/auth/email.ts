// src/auth/email.ts — magic-link delivery via Cloudflare Email Service
// (`send_email` binding named EMAIL in wrangler.toml).
//
// Never throws: if the binding is missing/unavailable (local dev, or the
// owner hasn't onboarded a sending domain yet) the link is logged and the
// caller can surface it on a dev page instead.

export interface EmailEnv {
  /** Cloudflare Email Service send binding. May be absent in local dev. */
  EMAIL?: SendEmail;
}

/**
 * Sender identity: any address on the domain onboarded for Email Sending
 * (currently planned: the apex domain noveladaptations.com — see README).
 * Kept as constants so the binding restriction (`allowed_sender_addresses`
 * in wrangler.toml) and the code can't drift apart.
 */
export const EMAIL_FROM_NAME = 'Novel Adaptations';
export const EMAIL_FROM_ADDRESS = 'noreply@noveladaptations.com';
export const EMAIL_SUBJECT = 'Your Novel Adaptations sign-in link';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the magic-link message in both HTML and plain-text form. The link is
 * HTML-escaped so a crafted token can never break out of the anchor.
 */
export function buildMagicLinkEmail(link: string): { html: string; text: string } {
  const safeLink = escapeHtml(link);
  const html =
    `<!doctype html><html><body style="margin:0;background:#0b0e14;font-family:system-ui,-apple-system,sans-serif;">` +
    `<div style="max-width:560px;margin:0 auto;padding:40px 24px;">` +
    `<div style="background:#141926;border:1px solid #232c3f;border-radius:12px;padding:36px 32px;text-align:center;">` +
    `<div style="font-size:26px;font-weight:800;letter-spacing:0.02em;color:#f5f2ea;margin-bottom:8px;">` +
    `🎬 Novel Adaptations</div>` +
    `<div style="color:#9aa4b8;font-size:14px;margin-bottom:24px;">Every book, every screen adaptation.</div>` +
    `<p style="color:#dbe1ec;font-size:15px;line-height:1.6;margin:0 0 28px;">` +
    `Click the button below to sign in. If you didn't request this, you can ignore this email.` +
    `</p>` +
    `<a href="${safeLink}" style="display:inline-block;background:#e8b64c;color:#141006;font-weight:700;` +
    `font-size:16px;text-decoration:none;padding:14px 40px;border-radius:8px;">Sign in</a>` +
    `<p style="color:#9aa4b8;font-size:13px;line-height:1.6;margin:28px 0 0;">` +
    `This link expires in <strong style="color:#dbe1ec;">15 minutes</strong> and can only be used once.<br>` +
    `If the button doesn't work, copy this link into your browser:<br>` +
    `<span style="color:#7d8aa3;word-break:break-all;">${safeLink}</span>` +
    `</p>` +
    `</div>` +
    `<p style="text-align:center;color:#5b6577;font-size:12px;margin-top:24px;">` +
    `Sent by Novel Adaptations · noveladaptations.com</p>` +
    `</div></body></html>`;

  const text =
    `Novel Adaptations — sign in\n\n` +
    `Click the link below to sign in. If you didn't request this, you can ignore this email.\n\n` +
    `${link}\n\n` +
    `This link expires in 15 minutes and can only be used once.\n\n` +
    `Sent by Novel Adaptations · noveladaptations.com`;

  return { html, text };
}

/**
 * Send the magic-link sign-in email via the Cloudflare Email Service binding.
 * @returns {sent: true} when the send succeeded; {sent: false} when the
 * binding is absent/unavailable or the send failed (logged, never thrown).
 */
export async function sendMagicLink(
  env: EmailEnv,
  email: string,
  link: string,
): Promise<{ sent: boolean }> {
  const binding = env.EMAIL;
  if (!binding || typeof binding.send !== 'function') {
    // Never log the link itself: it is a live credential. Development builds
    // surface it through the API's dev_link response field instead.
    console.log('[auth] EMAIL binding not configured — magic link not sent');
    return { sent: false };
  }

  const { html, text } = buildMagicLinkEmail(link);
  try {
    const res = await binding.send({
      to: email,
      from: { name: EMAIL_FROM_NAME, email: EMAIL_FROM_ADDRESS },
      subject: EMAIL_SUBJECT,
      html,
      text,
    });
    console.log('[auth] magic-link email sent', email, res?.messageId ?? '');
    return { sent: true };
  } catch (err) {
    // Cloudflare throws Errors with a `code` (E_SENDER_NOT_VERIFIED,
    // E_SENDER_DOMAIN_NOT_AVAILABLE, E_RATE_LIMIT_EXCEEDED, ...). A failed
    // send is a hard "email not configured" — never leak the link here.
    const code = err instanceof Error ? (err as { code?: string }).code : undefined;
    console.error('[auth] email send failed:', code, err instanceof Error ? err.message : err);
    return { sent: false };
  }
}
