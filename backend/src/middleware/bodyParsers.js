import express from 'express';
import { requireAuth } from './auth.js';

// The routers behind the larger limits below require auth, but only once the body has been
// parsed, so without a check in front of these parsers anyone could make the server read,
// inflate and parse up to 35 MB per request. index.js mounts the parsers before its session
// middleware, so these paths load the session themselves; express-session skips a request
// whose session is already loaded.
export function mountBodyParsers(app, sessionMiddleware) {
  const signedIn = [sessionMiddleware, requireAuthBeforeParsing];
  // 25 MB attachment limit → ~34 MB base64 on the wire; add headroom for the rest of the payload.
  app.use('/api/mail/send', signedIn, express.json({ limit: '35mb' }));
  app.use('/api/mail/draft', signedIn, express.json({ limit: '35mb' }));
  // A pet-import body carries a base64 spritesheet (~33% larger than the 5 MB sheet cap
  // enforced after decode in gtdPet.importPet), so it needs more than the global 1 MB.
  app.use('/api/gtd/pet/import', signedIn, express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '1mb' }));
  // Return a clean JSON error when the body parser rejects an oversized payload.
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request too large. Total attachment size must not exceed 25 MB.' });
    }
    next(err);
  });
}

// A signed-out request gets its 401 only after its body has been read off and discarded, as
// body-parser does before it reports an error. nginx and the Vite dev proxy send
// Connection: close, and Node closing such a socket with body data still unread resets the
// connection, which can lose the 401 before the client reads it.
function requireAuthBeforeParsing(req, res, next) {
  if (req.session?.userId) return requireAuth(req, res, next);
  req.on('end', () => requireAuth(req, res, next));
  req.resume();
}
