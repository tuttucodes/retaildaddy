function requireValue(name, value) {
  if (!String(value || "").trim()) throw new Error(`${name} is required for Twilio calling.`);
  return String(value).trim();
}

function encodeBasicAuth(username, password) {
  return Buffer.from(`${username}:${password}`).toString("base64");
}

function escapeXml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function absolutePublicUrl(publicBaseUrl, maybePath) {
  const base = requireValue("CALL_PUBLIC_BASE_URL", publicBaseUrl);
  return new URL(maybePath, base.endsWith("/") ? base : `${base}/`).toString();
}

export function publicWebSocketUrl(publicBaseUrl, maybePath) {
  const url = new URL(absolutePublicUrl(publicBaseUrl, maybePath));
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new Error(`Unsupported CALL_PUBLIC_BASE_URL protocol for WebSocket: ${url.protocol}`);
  return url.toString();
}

export function twiml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

export function playAndRecordTwiml({ audioUrl, actionUrl, maxLength = 7, timeout = 1 }) {
  const resolvedMaxLength = positiveInteger(maxLength, 7);
  const resolvedTimeout = positiveInteger(timeout, 1);
  return twiml(
    [
      `<Play>${escapeXml(audioUrl)}</Play>`,
      `<Record action="${escapeXml(actionUrl)}" method="POST" maxLength="${resolvedMaxLength}" timeout="${resolvedTimeout}" finishOnKey="#" playBeep="false" trim="trim-silence"/>`
    ].join("")
  );
}

export function recordOnlyTwiml({ actionUrl, maxLength = 7, timeout = 1 }) {
  const resolvedMaxLength = positiveInteger(maxLength, 7);
  const resolvedTimeout = positiveInteger(timeout, 1);
  return twiml(
    `<Record action="${escapeXml(actionUrl)}" method="POST" maxLength="${resolvedMaxLength}" timeout="${resolvedTimeout}" finishOnKey="#" playBeep="false" trim="trim-silence"/>`
  );
}

export function connectStreamTwiml({ streamUrl, statusCallbackUrl = "", parameters = {} }) {
  const parameterXml = Object.entries(parameters)
    .filter(([, value]) => value != null && String(value).trim() !== "")
    .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}"/>`)
    .join("");
  const statusAttributes = statusCallbackUrl
    ? ` statusCallback="${escapeXml(statusCallbackUrl)}" statusCallbackMethod="POST"`
    : "";
  return twiml(`<Connect><Stream url="${escapeXml(streamUrl)}"${statusAttributes}>${parameterXml}</Stream></Connect>`);
}

export function playAndHangupTwiml({ audioUrl }) {
  return twiml([`<Play>${escapeXml(audioUrl)}</Play>`, "<Hangup/>"].join(""));
}

export function playAndDialTwiml({ audioUrl, transferPhone }) {
  return twiml(
    [
      `<Play>${escapeXml(audioUrl)}</Play>`,
      `<Dial>${escapeXml(transferPhone)}</Dial>`
    ].join("")
  );
}

export async function createTwilioOutboundCall({
  accountSid,
  authToken,
  apiKeySid = "",
  apiKeySecret = "",
  from,
  to,
  webhookUrl,
  statusCallbackUrl = "",
  fetchImpl = fetch
}) {
  const sid = requireValue("TWILIO_ACCOUNT_SID", accountSid);
  const authUser = String(apiKeySid || "").trim() || sid;
  const authPass = String(apiKeySecret || "").trim() || requireValue("TWILIO_AUTH_TOKEN", authToken);
  const params = new URLSearchParams({
    To: requireValue("to", to),
    From: requireValue("TWILIO_FROM_NUMBER", from),
    Url: requireValue("webhookUrl", webhookUrl),
    Method: "POST"
  });
  if (statusCallbackUrl) {
    params.set("StatusCallback", statusCallbackUrl);
    params.set("StatusCallbackMethod", "POST");
    // Twilio's REST Calls API expects StatusCallbackEvent as repeated params, not a single space-joined value (else error 21626).
    for (const event of ["initiated", "ringing", "answered", "completed"]) {
      params.append("StatusCallbackEvent", event);
    }
  }

  const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${encodeBasicAuth(authUser, authPass)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Twilio call failed with HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

export async function fetchTwilioRecording({
  recordingUrl,
  accountSid,
  authToken,
  apiKeySid = "",
  apiKeySecret = "",
  fetchImpl = fetch
}) {
  const sid = requireValue("TWILIO_ACCOUNT_SID", accountSid);
  const authUser = String(apiKeySid || "").trim() || sid;
  const authPass = String(apiKeySecret || "").trim() || requireValue("TWILIO_AUTH_TOKEN", authToken);
  const url = String(recordingUrl || "").endsWith(".wav") ? recordingUrl : `${recordingUrl}.wav`;
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Basic ${encodeBasicAuth(authUser, authPass)}`
    }
  });
  if (!response.ok) {
    throw new Error(`Twilio recording download failed with HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
