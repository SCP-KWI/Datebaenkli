/**
 * The sign-in page.
 *
 * Split out of `login.html` for the CSP (phase 8.2) — see the header of
 * `home.js`, which says the same thing at more length.
 *
 * Note what this file deliberately does *not* import: `i18n.js`. The two
 * sentences a student actually hits are bilingual literals below, because a
 * page reached without a session has no locale to load and no account to read
 * one from.
 */

import { mountVersion } from '/assets/util.js';

// `de-CH` hardcoded, and it is the one place that is right: this page has
// no account to read a locale from, and it is German-first by design. The
// only visible difference from `en-CH` is zero-padding on the date.
mountVersion(document.getElementById('version'), (d) =>
  new Intl.DateTimeFormat('de-CH', { dateStyle: 'short', timeStyle: 'short' }).format(d),
);

const form = document.getElementById('form');
const error = document.getElementById('error');
const button = form.querySelector('button');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  button.disabled = true;
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      // The API's own message, not a translated one: `i18n.js` is not
      // loaded here on purpose — see the comment above the hint — and the
      // two failures a student actually hits get a bilingual sentence of
      // their own below.
      error.textContent =
        payload?.error?.code === 'invalid_credentials'
          ? 'Benutzername oder Passwort stimmt nicht. / That username or password is not right.'
          : (payload?.error?.message ?? 'Anmeldung fehlgeschlagen. / Sign-in failed.');
      return;
    }
    // A forced change is the server's rule; the redirect only saves the
    // user a dead end, it does not enforce anything.
    location.href = payload.user.mustChangePassword ? '/password' : '/';
  } catch {
    error.textContent = 'Keine Verbindung zum Server. / No connection to the server.';
  } finally {
    button.disabled = false;
  }
});
