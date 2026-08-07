/**
 * The change-password page.
 *
 * Split out of `password.html` for the CSP (phase 8.2) — see the header of
 * `home.js`.
 */

import { apply, errorText, formats, load, paintCached, t } from '/assets/i18n.js';
import { mountVersion } from '/assets/util.js';

const form = document.getElementById('form');
const error = document.getElementById('error');
const why = document.getElementById('why');
const button = form.querySelector('button');

// Started before the paint, awaited after — see `paintCached()`.
const mePromise = fetch('/api/me').then((r) => (r.ok ? r.json() : null));
await paintCached();

const me = await mePromise;
if (!me) location.href = '/login';
else {
  // Before the two lines below touch anything: `why` is one of the strings
  // apply() replaces, so loading the locale afterwards would overwrite the
  // forced-change sentence with the generic rule.
  await load(me.user.locale);
  apply();
  if (me.user.mustChangePassword) why.textContent = t('password.forced');
}

// Outside the branch: the footer is chrome and should render even for
// someone being redirected to /login, who sees this page for a moment.
mountVersion(document.getElementById('version'), (d) => formats().dateTime(d));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  if (form.next.value !== form.repeat.value) {
    error.textContent = t('password.mismatch');
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch('/api/me/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        currentPassword: form.current.value,
        newPassword: form.next.value,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      error.textContent = payload?.error ? errorText(payload.error) : t('password.failed');
      return;
    }
    location.href = '/';
  } catch {
    error.textContent = t('error.offline');
  } finally {
    button.disabled = false;
  }
});
