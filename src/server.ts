import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env, assertProductionSafety } from './config';
import { bootstrapAdapters } from './channels/bootstrap';
import { startWorker } from './worker';
import routes from './routes';

assertProductionSafety();

bootstrapAdapters();

if (env.EMBEDDED_WORKER) {
  startWorker();
}

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use(routes);

app.listen(env.PORT, () => {
  console.log(`postmidia API rodando na porta ${env.PORT}`);
});
