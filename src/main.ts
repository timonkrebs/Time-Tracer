import { isDevMode } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

import { App } from './app/app';
import { appConfig } from './app/app.config';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));

// Register the offline app-shell service worker in production builds only, so
// the dev server is never shadowed by a cache.
if (!isDevMode() && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('sw.js').catch(() => {
      // PWA support is progressive enhancement — ignore registration failures.
    });
  });
}
