import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import routes from './routes/index.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { env } from './config/env.js';

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors()); // TODO before production: restrict to your real origins
app.use(express.json({ limit: '1mb' }));
if (env.NODE_ENV !== 'test') app.use(morgan('dev'));

app.use('/api/v1', apiLimiter, routes);
app.use(notFound);
app.use(errorHandler);

export default app;