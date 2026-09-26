import { createServer, type Server } from "node:http";

/**
 * One-shot loopback server for an OAuth redirect.
 *
 * pi keeps its own callback servers private (`pi-ai/dist/auth/oauth/*` is not
 * an export path), so providers we add ourselves need this. Nothing here is
 * provider-specific: the port and path come from the caller, because an
 * installed-app client id is registered against one exact redirect URI and
 * cannot use an ephemeral port.
 *
 * `wait()` resolves once — with the callback parameters, or with undefined
 * after `cancel()`, which is how a manual paste prompt takes over on a
 * headless or remote machine where the browser cannot reach this process.
 */

export interface OAuthCallback {
  code: string;
  state: string;
}

export interface OAuthCallbackServer {
  readonly redirectUri: string;
  wait(): Promise<OAuthCallback | undefined>;
  /** Unblocks `wait()` with undefined; the caller still has to `close()`. */
  cancel(): void;
  close(): void;
}

export interface OAuthCallbackServerOptions {
  port: number;
  path: string;
  /** Overridable for containers that cannot bind loopback. */
  host?: string;
  successMessage?: string;
}

const STYLE = "font:16px system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.5rem;text-align:center";

function page(title: string, message: string, details?: string): string {
  const escape = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>`
    + `<body style="${STYLE}"><h1 style="font-size:1.25rem">${escape(title)}</h1>`
    + `<p>${escape(message)}</p>${details ? `<pre>${escape(details)}</pre>` : ""}</body>`;
}

export function oauthSuccessHtml(message: string): string {
  return page("Authorization received", message);
}

export function oauthErrorHtml(message: string, details?: string): string {
  return page("Sign-in failed", message, details);
}

export function startOAuthCallbackServer(options: OAuthCallbackServerOptions): Promise<OAuthCallbackServer> {
  const host = options.host ?? process.env.PI_OAUTH_CALLBACK_HOST ?? "127.0.0.1";
  const redirectUri = `http://localhost:${options.port}${options.path}`;

  return new Promise((resolve, reject) => {
    let settle: ((value: OAuthCallback | undefined) => void) | undefined;
    const waited = new Promise<OAuthCallback | undefined>((resolveWait) => {
      let settled = false;
      settle = (value) => {
        if (settled) return;
        settled = true;
        resolveWait(value);
      };
    });

    const html = (response: import("node:http").ServerResponse, status: number, body: string) => {
      response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      response.end(body);
    };

    const server: Server = createServer((request, response) => {
      const url = new URL(request.url ?? "", redirectUri);
      if (url.pathname !== options.path) {
        html(response, 404, oauthErrorHtml("Callback route not found."));
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        html(response, 400, oauthErrorHtml("Authentication did not complete.", error));
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        html(response, 400, oauthErrorHtml("Missing code or state parameter."));
        return;
      }

      html(response, 200, oauthSuccessHtml(options.successMessage ?? "You can close this window."));
      settle?.({ code, state });
    });

    server.on("error", reject);
    server.listen(options.port, host, () => {
      resolve({
        redirectUri,
        wait: () => waited,
        cancel: () => settle?.(undefined),
        close: () => server.close(),
      });
    });
  });
}
