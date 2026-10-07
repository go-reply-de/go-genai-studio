import type { RequestHandler, Response } from 'express';
import { isEnabled } from '~/utils/common';

/**
 * Fetch directives only. Browsers enforce every Content-Security-Policy header a response
 * carries, so this narrows whatever other policy is sent instead of replacing it.
 */
export const STRICT_EGRESS_POLICY: string = [
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' blob: data: about:",
].join('; ');

/** Also blocks browser speech recognition, which streams audio to the browser vendor. */
export const STRICT_PERMISSIONS_POLICY =
  'microphone=(), camera=(), geolocation=(), display-capture=()';

export function isStrictBrowserEgress(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env.STRICT_BROWSER_EGRESS);
}

/** Sends the strict egress policy and the permissions policy on every response. */
export function createStrictBrowserEgress(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Permissions-Policy', STRICT_PERMISSIONS_POLICY);
    let appended = false;
    const writeHead = res.writeHead;
    /* Appended as the head is written, so a handler that sets its own policy later
     * (the SPA shell does) adds a second header rather than replacing this one. */
    res.writeHead = function (this: Response, ...args: [number, unknown?, unknown?]) {
      if (!appended && !this.headersSent) {
        appended = true;
        this.appendHeader('Content-Security-Policy', STRICT_EGRESS_POLICY);
      }
      return writeHead.apply(this, args as Parameters<typeof writeHead>);
    } as Response['writeHead'];
    next();
  };
}
