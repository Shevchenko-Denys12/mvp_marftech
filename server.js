import path from 'node:path';
import { ROOT, loadEnv, loadBrand, loadRules, resolveProviderConfig } from './src/config.js';
import { createProvider } from './src/providers/index.js';
import { createApp } from './src/app.js';

loadEnv();

let provider;
try {
  provider = createProvider(resolveProviderConfig());
} catch (e) {
  console.error(`Помилка конфігурації: ${e.message}`);
  process.exit(1);
}

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);

const app = createApp({
  provider,
  brand: loadBrand(),
  rules: loadRules(),
  runLogPath: path.join(ROOT, 'data', 'runs.jsonl'),
  restrictHost: ['127.0.0.1', 'localhost', '::1'].includes(host)
});

app.listen(port, host, () => {
  console.log(`SockLock variant writer: http://${host}:${port}`);
  if (provider.label === 'mock') {
    console.log('Режим mock: ключа API немає, видаю шаблонні варіанти. Додайте GROQ_API_KEY у .env, щоб працювала модель.');
  } else {
    console.log(`Провайдер: ${provider.label}, моделі: ${provider.models.join(' -> ')}`);
  }
});
