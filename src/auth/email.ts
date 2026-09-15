// src/auth/email.ts — magic-link delivery via Resend.
// Never throws: if no key is configured (local dev) the link is logged and
// the caller can surface it on a dev page instead.

export interface EmailEnv {
  RESEND_API_KEY?: string;
}

const FROM = 'Novel Adaptations <noreply@noveladaptations.com>';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Send the magic-link sign-in email.
 * @returns {sent: true} on a 2xx from Resend; {sent: false} when no key is
 * configured or the request fails (logged, never thrown).
 */
export async function sendMagicLink(
  env: EmailEnv,
  email: string,
  link: string,
): Promise<{ sent: boolean }> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('[auth] magic link for', email, link);
    return { sent: false };
  }

  const html =
    `<p>Here's your sign-in link for <strong>Novel Adaptations</strong>:</p>` +
    `<p><a href="${escapeHtml(link)}">Sign in</a></p>` +
    `<p style="color:#666;font-size:12px">This link expires in 15 minutes and can only be used once.</p>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: email,
        subject: 'Your Novel Adaptations sign-in link',
        html,
      }),
    });
    if (!res.ok) {
      console.error('[auth] resend failed:', res.status, await res.text().catch(() => ''));
      return { sent: false };
    }
    return { sent: true };
  } catch (err) {
    console.error('[auth] resend error:', err);
    return { sent: false };
  }
}
