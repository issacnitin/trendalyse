import type { Account } from '../accounts.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element: ${id}`);
  return node as T;
}
let authMode: 'register' | 'login' = 'login';
const status = element('account-status');
const password = element<HTMLInputElement>('password');
const confirmation = element<HTMLInputElement>('confirm-password');
const submit = element<HTMLButtonElement>('account-submit');
const authSwitch = element<HTMLAnchorElement>('auth-switch');

function setAuthMode(mode: 'register' | 'login'): void {
  authMode = mode;
  const registering = mode === 'register';
  element('auth-title').textContent = registering ? 'Create your workspace.' : 'Welcome back.';
  element('auth-description').textContent = registering ? 'Start with an account. Connect your data in the dashboard.' : 'Sign in to continue your research.';
  element('confirm-field').hidden = !registering;
  element('registration-note').hidden = !registering;
  confirmation.required = registering;
  password.autocomplete = registering ? 'new-password' : 'current-password';
  password.value = '';
  confirmation.value = '';
  submit.textContent = registering ? 'Create account & continue →' : 'Sign in to dashboard →';
  element('switch-prompt').textContent = registering ? 'Already have an account?' : 'New to Trendalyse?';
  authSwitch.textContent = registering ? 'Sign in' : 'Create your account';
  authSwitch.href = registering ? '/login' : '/login?mode=register';
  status.textContent = '';
  status.classList.remove('error');
  document.title = `${registering ? 'Create account' : 'Sign in'} | Trendalyse`;
  history.replaceState(null, '', registering ? '/login?mode=register' : '/login');
}
authSwitch.addEventListener('click', (event) => {
  if (submit.disabled) event.preventDefault();
});
element('account-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (authMode === 'register' && password.value !== confirmation.value) {
    status.classList.add('error');
    status.textContent = 'Passwords do not match.';
    return;
  }
  submit.disabled = true;
  authSwitch.setAttribute('aria-disabled', 'true');
  status.classList.remove('error');
  status.textContent = authMode === 'register' ? 'Creating your account...' : 'Signing in...';
  void (async () => {
    try {
      const response = await fetch(`/api/${authMode}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: element<HTMLInputElement>('email').value, password: password.value }),
      });
      const data = await response.json() as { user?: Account; error?: string };
      if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
      if (!data.user) throw new Error('Your account could not be loaded. Please sign in again.');
      window.location.replace('/dashboard');
    } catch (error) {
      status.classList.add('error');
      status.textContent = error instanceof Error ? error.message : 'Unable to sign in. Please try again.';
    } finally {
      password.value = '';
      confirmation.value = '';
      submit.disabled = false;
      authSwitch.removeAttribute('aria-disabled');
    }
  })();
});
const query = new URLSearchParams(window.location.search);
setAuthMode(query.get('mode') === 'register' ? 'register' : 'login');
if (query.get('expired') === '1') status.textContent = 'Your session expired. Sign in to continue.';
