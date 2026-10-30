/**
 * Response headers and error replies for the HTTP side (audits SEC-3, SEC-7, SEC-8).
 */
import http from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { logRefusal, type OriginPolicy, refusalReason } from '../socket/originGuard.ts';

/**
 * Refuses requests from foreign pages or unexpected Host names (see originGuard.ts).
 * The same rule runs for Socket.IO in index.ts.
 */
export function originMiddleware(policy: OriginPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const reason = refusalReason(req.headers, policy);
    if (!reason) return next();
    logRefusal(req.headers, reason);
    res.status(403).json({ error: 'This server only accepts its own pages' });
  };
}

/**
 * The app shell may not be framed by other sites (clickjacking a host's controls).
 * SAMEORIGIN, not DENY: the game frames its own /media-html pages.
 * Media responses replace the CSP with their own sandbox policy; X-Frame-Options still applies.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

/**
 * Keeps 4xx statuses (express.static sends 403 for dotfiles) and never echoes an internal
 * error message, which can carry file paths, to the client.
 */
export function errorHandler(err: Error & { status?: number; statusCode?: number }, _req: Request, res: Response,
  next: NextFunction): void {
  // A media stream that fails midway already sent its headers; let Express close the socket.
  if (res.headersSent) { next(err); return; }
  const status = err.status ?? err.statusCode ?? 500;
  if (status === 404) { res.status(404).end(); return; }
  if (status >= 400 && status < 500) { res.status(status).json({ error: http.STATUS_CODES[status] ?? 'Request refused' }); return; }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
}
