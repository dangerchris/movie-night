export interface Notifier {
  /** Post a message; `html` may mention users with matrix.to links, `mentions` pings them. */
  send(text: string, html: string, mentions: string[]): Promise<void>;
}

/** Posts to one Matrix room through the client-server API with a bot access token. */
export function matrixNotifier(homeserver: string, accessToken: string, roomId: string): Notifier | null {
  if (!homeserver || !accessToken || !roomId) return null;
  const base = homeserver.replace(/\/+$/, "");
  let resolved: Promise<string> | null = null;
  // Accept a room alias (#movienight:server) or id (!abc:server).
  const room = () => resolved ??= roomId.startsWith("#")
    ? fetch(`${base}/_matrix/client/v3/directory/room/${encodeURIComponent(roomId)}`, { headers: { Authorization: `Bearer ${accessToken}` } })
        .then(async (r) => { if (!r.ok) throw new Error(`Matrix alias lookup failed (${r.status})`); return (await r.json()).room_id as string; })
        .catch((e) => { resolved = null; throw e; })
    : Promise.resolve(roomId);
  let txn = 0;
  return {
    async send(text, html, mentions) {
      const id = await room();
      const url = `${base}/_matrix/client/v3/rooms/${encodeURIComponent(id)}/send/m.room.message/mn${Date.now()}-${txn++}`;
      const res = await fetch(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          msgtype: "m.text", body: text, format: "org.matrix.custom.html", formatted_body: html,
          "m.mentions": { user_ids: mentions },
        }),
      });
      if (!res.ok) throw new Error(`Matrix send failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    },
  };
}
