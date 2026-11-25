import './styles/main.css';
import { NeonGmailApp } from './ui/App.ts';

function boot(): void {
  const root = document.getElementById('app');
  if (!root) return;
  new NeonGmailApp(root);

  if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        // Service worker registration skipped if blocked
      });
    });
  }
}

boot();
