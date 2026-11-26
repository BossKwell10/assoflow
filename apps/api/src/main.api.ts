import { creerApplication } from './bootstrap.js';
import { chargerConfig } from './config.js';

const config = chargerConfig();
const app = await creerApplication();
app.enableCors({ origin: config.CONSOLE_ORIGIN, credentials: true });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
