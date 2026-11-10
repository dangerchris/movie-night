import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AuthConfig {
  accessTeamDomain: string; // e.g. "yourteam.cloudflareaccess.com"
  accessAud: string;
  /** Who may use the "who's watching?" picker: nobody, only this machine, or any direct (non-tunnel) client. */
  picker: "off" | "localhost" | "lan";
  /** Shown to people who must sign in through the tunnel, e.g. "https://movienight.example.com". */
  publicUrl: string;
}

export function parsePickerMode(v: string | undefined): AuthConfig["picker"] {
  return v === "off" || v === "lan" ? v : "localhost";
}

function isLoopback(addr: string | null): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export const PICKER_COOKIE = "mn_user";

export type Identity =
  | { kind: "access"; email: string }
  | { kind: "picker"; email: string | null } // LAN visitor; email from cookie, may be unset
  | { kind: "denied"; reason: string };

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Requests forwarded by cloudflared carry Cloudflare edge headers; LAN requests don't. */
export function viaCloudflare(req: Request): boolean {
  return req.headers.has("cf-ray") || req.headers.has("cf-connecting-ip");
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** `remoteAddr` is the TCP peer address (null if unknown, which never counts as localhost). */
export async function identify(req: Request, cfg: AuthConfig, remoteAddr: string | null): Promise<Identity> {
  const token = req.headers.get("cf-access-jwt-assertion") ?? (viaCloudflare(req) ? readCookie(req, "CF_Authorization") : null);

  if (viaCloudflare(req) || token) {
    if (!cfg.accessTeamDomain || !cfg.accessAud)
      return { kind: "denied", reason: "Cloudflare Access is not configured on the server" };
    if (!token) return { kind: "denied", reason: "Missing Cloudflare Access token" };
    const domain = cfg.accessTeamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    jwks ??= createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));
    try {
      // ACCESS_AUD may list several apps (e.g. a wildcard app and a dedicated one), comma-separated.
      const audience = cfg.accessAud.split(",").map((a) => a.trim()).filter(Boolean);
      const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}`, audience });
      const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
      if (!email) return { kind: "denied", reason: "Access token has no email" };
      return { kind: "access", email };
    } catch {
      return { kind: "denied", reason: "Invalid Cloudflare Access token" };
    }
  }

  const pickerOk = cfg.picker === "lan" || (cfg.picker === "localhost" && isLoopback(remoteAddr));
  if (!pickerOk) {
    const where = cfg.publicUrl ? `Open ${cfg.publicUrl} to sign in with Google.` : "Sign in through the public URL.";
    return { kind: "denied", reason: where };
  }
  const email = readCookie(req, PICKER_COOKIE);
  return { kind: "picker", email: email ? email.toLowerCase() : null };
}
